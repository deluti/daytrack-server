import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { initDb } from '../db.js';

const router = express.Router();

router.post('/register', async (req, res) => {
  const { username, password } = req.body;
  const db = await initDb();
  
  const hashedPassword = await bcrypt.hash(password, 10);
  
  try {
    await db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword]);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: 'Username already exists' });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const db = await initDb();
  
  const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET || 'secret');
  res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar } });
});

export default router;