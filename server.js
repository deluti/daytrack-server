const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
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
  ssl: { rejectUnauthorized: false }
});

function getLastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

// Генерация кода премиум
function generatePremiumCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) code += '-';
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function initDb() {
  const client = await pool.connect();
  try {
    // Существующие таблицы
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        avatar TEXT DEFAULT '😊',
        is_premium BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS ratings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        date DATE NOT NULL,
        rating REAL NOT NULL,
        note TEXT,
        UNIQUE(user_id, date)
      );
      
      CREATE TABLE IF NOT EXISTS user_progress (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) UNIQUE,
        points INTEGER DEFAULT 0,
        level INTEGER DEFAULT 1,
        last_rated_date TEXT
      );
      
      -- Новая таблица для друзей
      CREATE TABLE IF NOT EXISTS favorites (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        favorite_id INTEGER NOT NULL REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, favorite_id)
      );
      
      -- Новая таблица для премиум кодов
      CREATE TABLE IF NOT EXISTS premium_codes (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        used_by INTEGER DEFAULT NULL,
        used_at TIMESTAMP DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Новая таблица для админов
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Таблицы созданы');
    
    // Создание админа если нет (пароль: ADMIN2024)
    const adminResult = await client.query('SELECT * FROM users WHERE username = $1', ['Admin']);
    if (adminResult.rows.length === 0) {
      const hashedPassword = await bcrypt.hash('ADMIN2024', 10);
      const result = await client.query(
        'INSERT INTO users (username, password, avatar, is_premium) VALUES ($1, $2, $3, $4) RETURNING id',
        ['Admin', hashedPassword, '👑', true]
      );
      await client.query('INSERT INTO admins (user_id) VALUES ($1)', [result.rows[0].id]);
    }
  } finally {
    client.release();
  }
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

async function isAdmin(userId) {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM admins WHERE user_id = $1', [userId]);
    return result.rows.length > 0;
  } finally {
    client.release();
  }
}

app.get('/api/test', (req, res) => {
  res.json({ message: 'Сервер работает!', status: 'ok' });
});

app.get('/', (req, res) => {
  res.json({ message: 'DayTrack API сервер работает' });
});

// ========== АУТЕНТИФИКАЦИЯ ==========

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
    await client.query('INSERT INTO user_progress (user_id, points, level) VALUES ($1, 0, 1)', [result.rows[0].id]);
    await client.query('COMMIT');
    res.json({ success: true, message: 'Пользователь создан' });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: 'Пользователь уже существует' });
  } finally {
    client.release();
  }
});

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
    res.json({ 
      token, 
      user: { 
        id: user.id, 
        username: user.username, 
        avatar: user.avatar,
        is_premium: user.is_premium 
      } 
    });
  } finally {
    client.release();
  }
});

// ========== ПРЕМИУМ ==========

// Активация премиум кода
app.post('/api/premium/activate', auth, async (req, res) => {
  const { code } = req.body;
  const client = await pool.connect();
  
  try {
    // Проверяем код
    const codeResult = await client.query(
      'SELECT * FROM premium_codes WHERE code = $1 AND used_by IS NULL',
      [code.toUpperCase()]
    );
    
    if (codeResult.rows.length === 0) {
      return res.status(400).json({ error: 'Неверный или уже использованный код' });
    }
    
    // Активируем премиум для пользователя
    await client.query('UPDATE users SET is_premium = TRUE WHERE id = $1', [req.userId]);
    
    // Отмечаем код как использованный
    await client.query(
      'UPDATE premium_codes SET used_by = $1, used_at = NOW() WHERE code = $2',
      [req.userId, code.toUpperCase()]
    );
    
    res.json({ success: true, message: 'Премиум активирован!' });
  } finally {
    client.release();
  }
});

// Обновление аватара
app.put('/api/user/avatar', auth, async (req, res) => {
  const { avatar } = req.body;
  const client = await pool.connect();
  try {
    await client.query('UPDATE users SET avatar = $1 WHERE id = $2', [avatar, req.userId]);
    res.json({ success: true, avatar });
  } finally {
    client.release();
  }
});

// ========== АДМИН ==========

// Проверка админа
app.get('/api/admin/check', auth, async (req, res) => {
  const admin = await isAdmin(req.userId);
  res.json({ isAdmin: admin });
});

// Генерация премиум кодов (только для админа)
app.post('/api/admin/generate-codes', auth, async (req, res) => {
  const admin = await isAdmin(req.userId);
  if (!admin) return res.status(403).json({ error: 'Доступ запрещен' });
  
  const { count = 1 } = req.body;
  const client = await pool.connect();
  const codes = [];
  
  try {
    for (let i = 0; i < count; i++) {
      const code = generatePremiumCode();
      await client.query('INSERT INTO premium_codes (code) VALUES ($1)', [code]);
      codes.push(code);
    }
    res.json({ codes });
  } finally {
    client.release();
  }
});

// ========== ДРУЗЬЯ (ИЗБРАННОЕ) ==========

// Добавить в избранное
app.post('/api/favorites/add', auth, async (req, res) => {
  const { favoriteId } = req.body;
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO favorites (user_id, favorite_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.userId, favoriteId]
    );
    res.json({ success: true });
  } finally {
    client.release();
  }
});

// Удалить из избранного
app.post('/api/favorites/remove', auth, async (req, res) => {
  const { favoriteId } = req.body;
  const client = await pool.connect();
  try {
    await client.query(
      'DELETE FROM favorites WHERE user_id = $1 AND favorite_id = $2',
      [req.userId, favoriteId]
    );
    res.json({ success: true });
  } finally {
    client.release();
  }
});

// Получить список избранных
app.get('/api/favorites', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT u.id, u.username, u.avatar, u.is_premium,
              COALESCE(up.points, 0) as points, COALESCE(up.level, 1) as level 
       FROM favorites f
       JOIN users u ON f.favorite_id = u.id
       LEFT JOIN user_progress up ON u.id = up.user_id
       WHERE f.user_id = $1
       ORDER BY u.username`,
      [req.userId]
    );
    res.json(result.rows);
  } finally {
    client.release();
  }
});

// Проверка в избранном
app.get('/api/favorites/check/:userId', auth, async (req, res) => {
  const { userId } = req.params;
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM favorites WHERE user_id = $1 AND favorite_id = $2',
      [req.userId, userId]
    );
    res.json({ isFavorite: result.rows.length > 0 });
  } finally {
    client.release();
  }
});

// ========== ОЦЕНКИ С ЗАМЕТКАМИ ==========

app.post('/api/ratings/rate', auth, async (req, res) => {
  const { date, rating, note } = req.body;
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO ratings (user_id, date, rating, note) 
       VALUES ($1, $2, $3, $4) 
       ON CONFLICT (user_id, date) DO UPDATE SET rating = $3, note = $4`,
      [req.userId, date, rating, note || '']
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Save error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

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
      'SELECT date, rating, note FROM ratings WHERE user_id = $1 AND date BETWEEN $2 AND $3 ORDER BY date',
      [req.userId, startDate, endDate]
    );
    const formattedRows = result.rows.map(row => ({
      date: row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date,
      rating: row.rating,
      note: row.note || ''
    }));
    res.json(formattedRows);
  } finally {
    client.release();
  }
});

app.get('/api/ratings/stats', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT COALESCE(AVG(rating), 0) as avgRating, COUNT(*) as totalDays FROM ratings WHERE user_id = $1',
      [req.userId]
    );
    res.json({
      avgRating: parseFloat(result.rows[0].avgrating) || 0,
      totalDays: parseInt(result.rows[0].totaldays) || 0
    });
  } finally {
    client.release();
  }
});

// ========== ПОИСК ПОЛЬЗОВАТЕЛЕЙ ==========

app.get('/api/users/search', auth, async (req, res) => {
  const { q } = req.query;
  const client = await pool.connect();
  
  if (!q || q.length < 2) {
    // Если нет поискового запроса, возвращаем избранных
    const favorites = await client.query(
      `SELECT u.id, u.username, u.avatar, u.is_premium,
              COALESCE(up.points, 0) as points, COALESCE(up.level, 1) as level,
              TRUE as is_favorite
       FROM favorites f
       JOIN users u ON f.favorite_id = u.id
       LEFT JOIN user_progress up ON u.id = up.user_id
       WHERE f.user_id = $1
       ORDER BY u.username`,
      [req.userId]
    );
    return res.json(favorites.rows);
  }
  
  try {
    const result = await client.query(
      `SELECT u.id, u.username, u.avatar, u.is_premium,
              COALESCE(up.points, 0) as points, COALESCE(up.level, 1) as level,
              EXISTS(SELECT 1 FROM favorites f WHERE f.user_id = $1 AND f.favorite_id = u.id) as is_favorite
       FROM users u
       LEFT JOIN user_progress up ON u.id = up.user_id
       WHERE u.username ILIKE $2 AND u.id != $1
       ORDER BY is_favorite DESC, u.username
       LIMIT 30`,
      [req.userId, `%${q}%`]
    );
    res.json(result.rows);
  } finally {
    client.release();
  }
});

// ========== ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ ==========

app.get('/api/users/:userId/profile', auth, async (req, res) => {
  const { userId } = req.params;
  const client = await pool.connect();
  try {
    const userResult = await client.query(
      'SELECT id, username, avatar, is_premium FROM users WHERE id = $1',
      [userId]
    );
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Не найден' });
    
    const statsResult = await client.query(
      'SELECT AVG(rating) as avgRating, COUNT(*) as totalDays FROM ratings WHERE user_id = $1',
      [userId]
    );
    
    const isFavoriteResult = await client.query(
      'SELECT * FROM favorites WHERE user_id = $1 AND favorite_id = $2',
      [req.userId, userId]
    );
    
    res.json({
      user: userResult.rows[0],
      stats: { 
        avgRating: statsResult.rows[0].avgrating || 0, 
        totalDays: statsResult.rows[0].totaldays || 0 
      },
      isFavorite: isFavoriteResult.rows.length > 0
    });
  } finally {
    client.release();
  }
});

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
      'SELECT date, rating, note FROM ratings WHERE user_id = $1 AND date BETWEEN $2 AND $3 ORDER BY date',
      [userId, startDate, endDate]
    );
    const formattedRows = result.rows.map(row => ({
      date: row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date,
      rating: row.rating,
      note: row.note || ''
    }));
    res.json(formattedRows);
  } finally {
    client.release();
  }
});

// ========== ПРОГРЕСС ==========

app.get('/api/user/progress', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    let result = await client.query(
      'SELECT points, level, last_rated_date FROM user_progress WHERE user_id = $1',
      [req.userId]
    );
    if (result.rows.length === 0) {
      await client.query('INSERT INTO user_progress (user_id, points, level) VALUES ($1, 0, 1)', [req.userId]);
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

// Обновление профиля
app.put('/api/user/profile', auth, async (req, res) => {
  const { username, avatar } = req.body;
  const client = await pool.connect();
  try {
    if (username) {
      const existing = await client.query('SELECT id FROM users WHERE username = $1 AND id != $2', [username, req.userId]);
      if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'Имя пользователя уже занято' });
      }
      await client.query('UPDATE users SET username = $1 WHERE id = $2', [username, req.userId]);
    }
    if (avatar) {
      await client.query('UPDATE users SET avatar = $1 WHERE id = $2', [avatar, req.userId]);
    }
    const result = await client.query('SELECT id, username, avatar, is_premium FROM users WHERE id = $1', [req.userId]);
    res.json({ success: true, user: result.rows[0] });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 5000;
initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`);
  });
});