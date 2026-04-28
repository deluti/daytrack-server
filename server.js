const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();

app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        avatar TEXT DEFAULT '😊',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS ratings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        date DATE NOT NULL,
        rating REAL NOT NULL,
        UNIQUE(user_id, date)
      );
      
      CREATE TABLE IF NOT EXISTS user_progress (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) UNIQUE,
        points INTEGER DEFAULT 0,
        level INTEGER DEFAULT 1,
        last_rated_date TEXT
      );
    `);
    console.log('✅ Таблицы созданы');
  } finally {
    client.release();
  }
}

// Функция получения последнего дня месяца
function getLastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

async function auth(req, res, next) {
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

app.get('/api/test', (req, res) => {
  res.json({ message: 'Сервер работает!', status: 'ok', time: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ message: 'DayTrack API сервер работает' });
});

// РЕГИСТРАЦИЯ
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  const client = await pool.connect();
  const hashedPassword = await bcrypt.hash(password, 10);
  
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id',
      [username, hashedPassword]
    );
    const userId = result.rows[0].id;
    await client.query(
      'INSERT INTO user_progress (user_id, points, level) VALUES ($1, 0, 1)',
      [userId]
    );
    await client.query('COMMIT');
    res.json({ success: true, message: 'Пользователь создан' });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: 'Пользователь уже существует' });
  } finally {
    client.release();
  }
});

// ВХОД
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const client = await pool.connect();
  
  try {
    const result = await client.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Неверные данные' });
    
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Неверные данные' });
    
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET || 'secret123');
    res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar } });
  } finally {
    client.release();
  }
});

// СОХРАНИТЬ ОЦЕНКУ
app.post('/api/ratings/rate', auth, async (req, res) => {
  const { date, rating } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query(
      `INSERT INTO ratings (user_id, date, rating) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (user_id, date) DO UPDATE SET rating = $3`,
      [req.userId, date, rating]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// ПОЛУЧИТЬ ОЦЕНКИ ЗА МЕСЯЦ (ИСПРАВЛЕНО)
app.get('/api/ratings/month/:year/:month', auth, async (req, res) => {
  const { year, month } = req.params;
  const client = await pool.connect();
  
  const monthNum = parseInt(month);
  const yearNum = parseInt(year);
  const lastDay = getLastDayOfMonth(yearNum, monthNum);
  
  const startDate = `${year}-${month.padStart(2, '0')}-01`;
  const endDate = `${year}-${month.padStart(2, '0')}-${lastDay.toString().padStart(2, '0')}`;
  
  try {
    const result = await client.query(
      'SELECT date, rating FROM ratings WHERE user_id = $1 AND date BETWEEN $2 AND $3',
      [req.userId, startDate, endDate]
    );
    res.json(result.rows);
  } finally {
    client.release();
  }
});

// СТАТИСТИКА
app.get('/api/ratings/stats', auth, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      'SELECT AVG(rating) as avgRating, COUNT(*) as totalDays FROM ratings WHERE user_id = $1',
      [req.userId]
    );
    res.json({
      avgRating: result.rows[0].avgrating || 0,
      totalDays: result.rows[0].totaldays || 0
    });
  } finally {
    client.release();
  }
});

// ОБНОВИТЬ ПРОФИЛЬ
app.put('/api/user/profile', auth, async (req, res) => {
  const { username, avatar } = req.body;
  const client = await pool.connect();
  
  try {
    if (username) {
      const existing = await client.query(
        'SELECT id FROM users WHERE username = $1 AND id != $2',
        [username, req.userId]
      );
      if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'Имя пользователя уже занято' });
      }
      await client.query('UPDATE users SET username = $1 WHERE id = $2', [username, req.userId]);
    }
    
    if (avatar) {
      await client.query('UPDATE users SET avatar = $1 WHERE id = $2', [avatar, req.userId]);
    }
    
    const result = await client.query('SELECT id, username, avatar FROM users WHERE id = $1', [req.userId]);
    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// ПОИСК ПОЛЬЗОВАТЕЛЕЙ
app.get('/api/users/search', auth, async (req, res) => {
  const { q } = req.query;
  const client = await pool.connect();
  
  if (!q || q.length < 2) {
    return res.json([]);
  }
  
  try {
    const result = await client.query(
      `SELECT u.id, u.username, u.avatar, 
              COALESCE(up.points, 0) as points, 
              COALESCE(up.level, 1) as level 
       FROM users u
       LEFT JOIN user_progress up ON u.id = up.user_id
       WHERE u.username ILIKE $1 AND u.id != $2
       ORDER BY u.username
       LIMIT 20`,
      [`%${q}%`, req.userId]
    );
    res.json(result.rows);
  } finally {
    client.release();
  }
});

// Профиль пользователя
app.get('/api/users/:userId/profile', auth, async (req, res) => {
  const { userId } = req.params;
  const client = await pool.connect();
  
  try {
    const userResult = await client.query('SELECT id, username, avatar FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    const statsResult = await client.query(
      'SELECT AVG(rating) as avgRating, COUNT(*) as totalDays FROM ratings WHERE user_id = $1',
      [userId]
    );
    
    res.json({
      user: userResult.rows[0],
      stats: {
        avgRating: statsResult.rows[0].avgrating || 0,
        totalDays: statsResult.rows[0].totaldays || 0
      }
    });
  } finally {
    client.release();
  }
});

// Оценки пользователя за месяц (ИСПРАВЛЕНО)
app.get('/api/users/:userId/ratings/:year/:month', auth, async (req, res) => {
  const { userId, year, month } = req.params;
  const client = await pool.connect();
  
  const monthNum = parseInt(month);
  const yearNum = parseInt(year);
  const lastDay = getLastDayOfMonth(yearNum, monthNum);
  
  const startDate = `${year}-${month.padStart(2, '0')}-01`;
  const endDate = `${year}-${month.padStart(2, '0')}-${lastDay.toString().padStart(2, '0')}`;
  
  try {
    const result = await client.query(
      'SELECT date, rating FROM ratings WHERE user_id = $1 AND date BETWEEN $2 AND $3',
      [userId, startDate, endDate]
    );
    res.json(result.rows);
  } finally {
    client.release();
  }
});

// ПРОГРЕСС
app.get('/api/user/progress', auth, async (req, res) => {
  const client = await pool.connect();
  
  try {
    let result = await client.query(
      'SELECT points, level, last_rated_date FROM user_progress WHERE user_id = $1',
      [req.userId]
    );
    
    if (result.rows.length === 0) {
      await client.query(
        'INSERT INTO user_progress (user_id, points, level) VALUES ($1, 0, 1)',
        [req.userId]
      );
      result = { rows: [{ points: 0, level: 1, last_rated_date: null }] };
    }
    
    res.json(result.rows[0]);
  } finally {
    client.release();
  }
});

app.post('/api/user/progress', auth, async (req, res) => {
  const { points, level, last_rated_date } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query(
      `INSERT INTO user_progress (user_id, points, level, last_rated_date) 
       VALUES ($1, $2, $3, $4) 
       ON CONFLICT (user_id) DO UPDATE SET 
         points = EXCLUDED.points, 
         level = EXCLUDED.level, 
         last_rated_date = EXCLUDED.last_rated_date`,
      [req.userId, points, level, last_rated_date]
    );
    res.json({ success: true });
  } finally {
    client.release();
  }
});

app.get('/api/users/:userId/progress', auth, async (req, res) => {
  const { userId } = req.params;
  const client = await pool.connect();
  
  try {
    const result = await client.query('SELECT points, level FROM user_progress WHERE user_id = $1', [userId]);
    res.json(result.rows[0] || { points: 0, level: 1 });
  } finally {
    client.release();
  }
});

// ========== ЗАПУСК ==========
const PORT = process.env.PORT || 5000;
initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`);
  });
});