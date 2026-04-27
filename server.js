const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();

// ========== CORS ==========
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// ========== ТЕСТОВЫЕ МАРШРУТЫ ==========
app.get('/api/test', (req, res) => {
  res.json({ message: 'Сервер работает!', status: 'ok', time: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ 
    message: 'DayTrack API сервер работает', 
    endpoints: [
      'GET /api/test',
      'POST /api/auth/register', 
      'POST /api/auth/login',
      'GET /api/users',
      'GET /api/users/:userId/profile',
      'GET /api/user/progress',
      'POST /api/user/progress'
    ]
  });
});

// Инициализация базы данных
async function openDb() {
  return open({
    filename: './database.db',
    driver: sqlite3.Database
  });
}

// Создание таблиц
async function initDb() {
  const db = await openDb();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      avatar TEXT DEFAULT '😊',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date DATE NOT NULL,
      rating REAL NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id),
      UNIQUE(user_id, date)
    );
    
    CREATE TABLE IF NOT EXISTS user_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      points INTEGER DEFAULT 0,
      level INTEGER DEFAULT 1,
      last_rated_date TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id),
      UNIQUE(user_id)
    );
  `);
  return db;
}

// Middleware для проверки токена
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret123');
    req.userId = decoded.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Неверный токен' });
  }
}

// ========== АУТЕНТИФИКАЦИЯ ==========

// РЕГИСТРАЦИЯ
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  const db = await initDb();
  
  const hashedPassword = await bcrypt.hash(password, 10);
  
  try {
    await db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword]);
    res.json({ success: true, message: 'Пользователь создан' });
  } catch (error) {
    res.status(400).json({ error: 'Пользователь уже существует' });
  }
});

// ВХОД
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const db = await initDb();
  
  const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
  if (!user) return res.status(401).json({ error: 'Неверные данные' });
  
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Неверные данные' });
  
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET || 'secret123');
  res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar } });
});

// ========== ОЦЕНКИ ==========

// СОХРАНИТЬ ОЦЕНКУ
app.post('/api/ratings/rate', auth, async (req, res) => {
  const { date, rating } = req.body;
  const db = await initDb();
  
  try {
    await db.run(
      'INSERT INTO ratings (user_id, date, rating) VALUES (?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET rating = ?',
      [req.userId, date, rating, rating]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ПОЛУЧИТЬ ОЦЕНКИ ЗА МЕСЯЦ
app.get('/api/ratings/month/:year/:month', auth, async (req, res) => {
  const { year, month } = req.params;
  const db = await initDb();
  
  const startDate = `${year}-${month.padStart(2, '0')}-01`;
  const endDate = `${year}-${month.padStart(2, '0')}-31`;
  
  const ratings = await db.all(
    'SELECT date, rating FROM ratings WHERE user_id = ? AND date BETWEEN ? AND ?',
    [req.userId, startDate, endDate]
  );
  
  res.json(ratings);
});

// СТАТИСТИКА
app.get('/api/ratings/stats', auth, async (req, res) => {
  const db = await initDb();
  
  const avg = await db.get(
    'SELECT AVG(rating) as avgRating, COUNT(*) as totalDays FROM ratings WHERE user_id = ?',
    [req.userId]
  );
  
  res.json({
    avgRating: avg.avgRating || 0,
    totalDays: avg.totalDays || 0
  });
});

// ========== ПРОФИЛЬ ==========

// ОБНОВИТЬ ПРОФИЛЬ
app.put('/api/user/profile', auth, async (req, res) => {
  const { username, avatar } = req.body;
  const db = await initDb();
  
  try {
    if (username) {
      const existing = await db.get('SELECT id FROM users WHERE username = ? AND id != ?', [username, req.userId]);
      if (existing) {
        return res.status(400).json({ error: 'Имя пользователя уже занято' });
      }
      await db.run('UPDATE users SET username = ? WHERE id = ?', [username, req.userId]);
    }
    
    if (avatar) {
      await db.run('UPDATE users SET avatar = ? WHERE id = ?', [avatar, req.userId]);
    }
    
    const updatedUser = await db.get('SELECT id, username, avatar FROM users WHERE id = ?', [req.userId]);
    res.json({ success: true, user: updatedUser });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== ПРОСМОТР ДРУГИХ ПОЛЬЗОВАТЕЛЕЙ ==========

// Получить список пользователей
app.get('/api/users', auth, async (req, res) => {
  const db = await initDb();
  const users = await db.all(
    'SELECT id, username, avatar FROM users WHERE id != ? ORDER BY username',
    [req.userId]
  );
  res.json(users);
});

// Получить публичный профиль пользователя
app.get('/api/users/:userId/profile', auth, async (req, res) => {
  const { userId } = req.params;
  const db = await initDb();
  
  const user = await db.get('SELECT id, username, avatar FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  
  const stats = await db.get(
    'SELECT AVG(rating) as avgRating, COUNT(*) as totalDays FROM ratings WHERE user_id = ?',
    [userId]
  );
  
  const progress = await db.get(
    'SELECT points, level FROM user_progress WHERE user_id = ?',
    [userId]
  );
  
  res.json({
    user,
    stats: {
      avgRating: stats.avgRating || 0,
      totalDays: stats.totalDays || 0
    },
    progress: progress || { points: 0, level: 1 }
  });
});

// Получить оценки пользователя за месяц
app.get('/api/users/:userId/ratings/:year/:month', auth, async (req, res) => {
  const { userId, year, month } = req.params;
  const db = await initDb();
  
  const startDate = `${year}-${month.padStart(2, '0')}-01`;
  const endDate = `${year}-${month.padStart(2, '0')}-31`;
  
  const ratings = await db.all(
    'SELECT date, rating FROM ratings WHERE user_id = ? AND date BETWEEN ? AND ?',
    [userId, startDate, endDate]
  );
  
  res.json(ratings);
});

// Поиск пользователей
app.get('/api/users/search', auth, async (req, res) => {
  const { q } = req.query;
  const db = await initDb();
  
  const users = await db.all(
    'SELECT id, username, avatar FROM users WHERE username LIKE ? AND id != ? LIMIT 20',
    [`%${q}%`, req.userId]
  );
  
  res.json(users);
});

// ========== ПРОГРЕСС (ОЧКИ И УРОВНИ) ==========

// Получить прогресс пользователя
app.get('/api/user/progress', auth, async (req, res) => {
  const db = await initDb();
  
  let progress = await db.get(
    'SELECT points, level, last_rated_date FROM user_progress WHERE user_id = ?',
    [req.userId]
  );
  
  if (!progress) {
    await db.run(
      'INSERT INTO user_progress (user_id, points, level) VALUES (?, 0, 1)',
      [req.userId]
    );
    progress = { points: 0, level: 1, last_rated_date: null };
  }
  
  res.json(progress);
});

// Обновить прогресс пользователя
app.post('/api/user/progress', auth, async (req, res) => {
  const { points, level, last_rated_date } = req.body;
  const db = await initDb();
  
  await db.run(
    `INSERT INTO user_progress (user_id, points, level, last_rated_date) 
     VALUES (?, ?, ?, ?) 
     ON CONFLICT(user_id) DO UPDATE SET 
       points = excluded.points, 
       level = excluded.level, 
       last_rated_date = excluded.last_rated_date`,
    [req.userId, points, level, last_rated_date]
  );
  
  res.json({ success: true });
});

// Получить прогресс другого пользователя
app.get('/api/users/:userId/progress', auth, async (req, res) => {
  const { userId } = req.params;
  const db = await initDb();
  
  const progress = await db.get(
    'SELECT points, level FROM user_progress WHERE user_id = ?',
    [userId]
  );
  
  res.json(progress || { points: 0, level: 1 });
});

// ========== ЗАПУСК СЕРВЕРА ==========
const PORT = process.env.PORT || 5000;
initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`);
  });
});

// Проверка и потеря очков при пропуске дня
const checkAndLosePoints = () => {
  if (!lastRatedDate) return;
  
  const last = new Date(lastRatedDate);
  const now = new Date();
  const lastMSK = new Date(last.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  const nowMSK = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  
  const daysPassed = Math.floor((nowMSK - lastMSK) / (1000 * 60 * 60 * 24));
  
  // Если пропущен 1 день - штраф 5 очков
  if (daysPassed === 1 && canGetPoint()) {
    const newPoints = Math.max(0, points - 5);
    const newLevel = Math.floor(newPoints / 30) + 1;
    setPoints(newPoints);
    setLevel(newLevel);
    saveProgressToServer(newPoints, newLevel, lastRatedDate);
    alert(`⚠️ Вы пропустили день! -5 очков. Уровень: ${newLevel}`);
  }
  // Если пропущено 2+ дня - сброс до 0
  else if (daysPassed >= 2) {
    setPoints(0);
    setLevel(1);
    setLastRatedDate(null);
    saveProgressToServer(0, 1, null);
    alert(`⚠️ Вы пропустили несколько дней! Уровень сброшен до 1`);
  }
};