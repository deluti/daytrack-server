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
      'GET /api/users/:userId/profile'
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
  
  const allRatings = await db.all(
    'SELECT date FROM ratings WHERE user_id = ? ORDER BY date',
    [req.userId]
  );
  
  let maxStreak = 0;
  let currentStreak = 1;
  
  if (allRatings.length > 0) {
    for (let i = 1; i < allRatings.length; i++) {
      const prevDate = new Date(allRatings[i-1].date);
      const currDate = new Date(allRatings[i].date);
      const diffDays = (currDate - prevDate) / (1000 * 60 * 60 * 24);
      
      if (diffDays === 1) {
        currentStreak++;
      } else {
        maxStreak = Math.max(maxStreak, currentStreak);
        currentStreak = 1;
      }
    }
    maxStreak = Math.max(maxStreak, currentStreak);
  }
  
  res.json({
    avgRating: avg.avgRating || 0,
    totalDays: avg.totalDays || 0,
    maxStreak: maxStreak
  });
});

// ВСЕ ОЦЕНКИ ДЛЯ ГРАФИКА
app.get('/api/ratings/all', auth, async (req, res) => {
  const db = await initDb();
  const ratings = await db.all(
    'SELECT date, rating FROM ratings WHERE user_id = ? ORDER BY date',
    [req.userId]
  );
  res.json(ratings);
});

// ========== ПРОФИЛЬ ==========

// ОБНОВИТЬ ПРОФИЛЬ
app.put('/api/user/profile', auth, async (req, res) => {
  const { username, avatar } = req.body;
  const db = await initDb();
  
  await db.run(
    'UPDATE users SET username = ?, avatar = ? WHERE id = ?',
    [username, avatar, req.userId]
  );
  
  res.json({ success: true });
});

// ========== ПРОСМОТР ДРУГИХ ПОЛЬЗОВАТЕЛЕЙ ==========

// Получить список пользователей (для поиска)
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
  
  const user = await db.get(
    'SELECT id, username, avatar FROM users WHERE id = ?',
    [userId]
  );
  
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  
  const stats = await db.get(
    'SELECT AVG(rating) as avgRating, COUNT(*) as totalDays FROM ratings WHERE user_id = ?',
    [userId]
  );
  
  const allRatings = await db.all(
    'SELECT date FROM ratings WHERE user_id = ? ORDER BY date',
    [userId]
  );
  
  let maxStreak = 0;
  let currentStreak = 1;
  
  if (allRatings.length > 0) {
    for (let i = 1; i < allRatings.length; i++) {
      const prevDate = new Date(allRatings[i-1].date);
      const currDate = new Date(allRatings[i].date);
      const diffDays = (currDate - prevDate) / (1000 * 60 * 60 * 24);
      
      if (diffDays === 1) {
        currentStreak++;
      } else {
        maxStreak = Math.max(maxStreak, currentStreak);
        currentStreak = 1;
      }
    }
    maxStreak = Math.max(maxStreak, currentStreak);
  }
  
  res.json({
    user,
    stats: {
      avgRating: stats.avgRating || 0,
      totalDays: stats.totalDays || 0,
      maxStreak: maxStreak
    }
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

// ========== ЗАПУСК СЕРВЕРА ==========
const PORT = process.env.PORT || 5000;
initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`);
  });
});