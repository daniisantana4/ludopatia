const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Database ──────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'casino.db');
let db;

async function initDB() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    balance REAL DEFAULT 1000,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    winning_number INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS bet_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    round_id INTEGER NOT NULL,
    total_bet REAL DEFAULT 0,
    total_payout REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS balance_snapshots (
    user_id INTEGER NOT NULL,
    balance REAL NOT NULL,
    snapshot_date TEXT NOT NULL,
    PRIMARY KEY(user_id, snapshot_date)
  )`);
  saveDB();
}

function saveDB() {
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) {
    console.error('Error saving DB:', e);
  }
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbGet(sql, params = []) {
  const rows = dbAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function dbRun(sql, params = []) {
  db.run(sql, params);
}

function dbLastInsertId() {
  const row = dbGet('SELECT last_insert_rowid() as id');
  return row ? row.id : 0;
}

// ── Sessions ──────────────────────────────────────────────
const sessions = new Map();

// ── Roulette data ─────────────────────────────────────────
const WHEEL_ORDER = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
const RED_NUMBERS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

function getColor(n) {
  if (n === 0) return 'green';
  return RED_NUMBERS.has(n) ? 'red' : 'black';
}

// ── Game state ────────────────────────────────────────────
let gamePhase = 'waiting';
let phaseTimer = 3;
let winningNumber = null;
let lastWinningNumber = 0;
const roundBets = new Map(); // socketId -> [{ betKey, numbers, amount }]
const resultHistory = [];

const PAYOUT_MAP = { 1: 35, 2: 17, 3: 11, 4: 8, 6: 5, 12: 2, 18: 1 };
const BETTING_TIME = 15;

function calculatePayouts() {
  dbRun('INSERT INTO rounds (winning_number) VALUES (?)', [winningNumber]);
  const roundId = dbLastInsertId();
  const payouts = {};

  for (const [socketId, userBets] of roundBets.entries()) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket || !socket.data.userId) continue;
    const userId = socket.data.userId;
    let totalBet = 0;
    let totalPayout = 0;

    for (const bet of userBets) {
      totalBet += bet.amount;
      if (bet.numbers.includes(winningNumber)) {
        const ratio = PAYOUT_MAP[bet.numbers.length] || 0;
        // Payout = bet back + winnings (bet was already deducted)
        totalPayout += bet.amount + bet.amount * ratio;
      }
    }

    // Balance was already deducted when bets were placed.
    // Now add back any winnings.
    const user = dbGet('SELECT balance FROM users WHERE id = ?', [userId]);
    if (user) {
      const newBalance = user.balance + totalPayout;
      dbRun('UPDATE users SET balance = ? WHERE id = ?', [newBalance, userId]);
      payouts[socketId] = { userId, totalBet, totalPayout, newBalance, username: socket.data.username };
    }

    dbRun('INSERT INTO bet_history (user_id, round_id, total_bet, total_payout) VALUES (?,?,?,?)',
      [userId, roundId, totalBet, totalPayout]);
  }
  saveDB();
  return payouts;
}

function takeSnapshots() {
  if (!db) return;
  const today = new Date().toISOString().slice(0, 10);
  const users = dbAll('SELECT id, balance FROM users');
  for (const u of users) {
    dbRun('INSERT OR IGNORE INTO balance_snapshots (user_id, balance, snapshot_date) VALUES (?,?,?)',
      [u.id, u.balance, today]);
  }
  saveDB();
}

// ── Game loop ─────────────────────────────────────────────
function gameLoop() {
  if (!db) return;
  if (io.sockets.sockets.size === 0 && gamePhase === 'waiting') return;

  if (gamePhase === 'waiting') {
    let hasAuth = false;
    for (const [, s] of io.sockets.sockets) { if (s.data.userId) { hasAuth = true; break; } }
    if (!hasAuth) return;
    gamePhase = 'betting';
    phaseTimer = BETTING_TIME;
    io.emit('phase', { phase: 'betting', timer: phaseTimer });
    return;
  }

  if (gamePhase === 'betting') {
    phaseTimer--;
    if (phaseTimer <= 0) {
      winningNumber = Math.floor(Math.random() * 37);
      gamePhase = 'spinning';
      phaseTimer = 7;
      io.emit('phase', { phase: 'spinning', timer: phaseTimer, number: winningNumber, lastNumber: lastWinningNumber });
    } else {
      io.emit('phase', { phase: 'betting', timer: phaseTimer });
    }
  } else if (gamePhase === 'spinning') {
    phaseTimer--;
    if (phaseTimer <= 0) {
      gamePhase = 'result';
      phaseTimer = 5;
      const payouts = calculatePayouts();
      resultHistory.unshift({ number: winningNumber, color: getColor(winningNumber) });
      if (resultHistory.length > 20) resultHistory.pop();
      io.emit('phase', { phase: 'result', timer: phaseTimer, number: winningNumber, payouts, history: resultHistory });
      for (const [sid, info] of Object.entries(payouts)) {
        const sock = io.sockets.sockets.get(sid);
        if (sock) sock.emit('balanceUpdate', { balance: info.newBalance, payout: info.totalPayout, bet: info.totalBet });
      }
    }
  } else if (gamePhase === 'result') {
    phaseTimer--;
    if (phaseTimer <= 0) {
      lastWinningNumber = winningNumber;
      roundBets.clear();
      gamePhase = 'betting';
      phaseTimer = BETTING_TIME;
      io.emit('phase', { phase: 'betting', timer: phaseTimer, history: resultHistory });
    } else {
      io.emit('phase', { phase: 'result', timer: phaseTimer });
    }
  }
}

setInterval(gameLoop, 1000);

// ── Auth routes ───────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Faltan campos' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'El usuario debe tener entre 3 y 20 caracteres' });
  if (password.length < 4) return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Solo letras, números y guion bajo' });

  const exists = dbGet('SELECT id FROM users WHERE username = ?', [username]);
  if (exists) return res.status(400).json({ error: 'El usuario ya existe' });

  const hash = bcrypt.hashSync(password, 10);
  dbRun('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hash]);
  const userId = dbLastInsertId();
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, username });
  saveDB();
  takeSnapshots();
  res.json({ token, username, balance: 1000 });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Faltan campos' });

  const user = dbGet('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Credenciales incorrectas' });

  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: user.id, username: user.username });
  res.json({ token, username: user.username, balance: user.balance });
});

// ── Leaderboard routes ────────────────────────────────────
app.get('/api/leaderboard/:type', (req, res) => {
  const type = req.params.type;
  if (type === 'alltime') {
    return res.json(dbAll('SELECT username, balance FROM users ORDER BY balance DESC LIMIT 50'));
  }

  const now = new Date();
  let dateStr;
  if (type === 'daily') {
    dateStr = now.toISOString().slice(0, 10);
  } else if (type === 'weekly') {
    const day = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((day + 6) % 7));
    dateStr = monday.toISOString().slice(0, 10);
  } else {
    return res.status(400).json({ error: 'Tipo inválido' });
  }

  const rows = dbAll(`
    SELECT u.username, u.balance, u.balance - COALESCE(s.balance, 1000) as profit
    FROM users u
    LEFT JOIN balance_snapshots s ON u.id = s.user_id AND s.snapshot_date = ?
    ORDER BY profit DESC
    LIMIT 50
  `, [dateStr]);
  res.json(rows);
});

// ── Socket.io ─────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.emit('gameState', { phase: gamePhase, timer: phaseTimer, history: resultHistory, lastNumber: lastWinningNumber });

  socket.on('auth', (token) => {
    const session = sessions.get(token);
    if (!session) return socket.emit('authError', 'Sesión inválida');
    socket.data.userId = session.userId;
    socket.data.username = session.username;
    const user = dbGet('SELECT balance FROM users WHERE id = ?', [session.userId]);
    socket.emit('authOk', { username: session.username, balance: user?.balance || 0 });
    if (gamePhase === 'waiting') {
      gamePhase = 'betting';
      phaseTimer = BETTING_TIME;
      io.emit('phase', { phase: 'betting', timer: phaseTimer, history: resultHistory });
    }
  });

  socket.on('placeBet', (data) => {
    if (gamePhase !== 'betting') return socket.emit('betError', 'No se aceptan apuestas ahora');
    if (!socket.data.userId) return socket.emit('betError', 'No autenticado');

    const { betKey, numbers, amount } = data;
    if (!Array.isArray(numbers) || numbers.length === 0 || amount <= 0) return socket.emit('betError', 'Apuesta inválida');
    if (![1, 2, 3, 4, 6, 12, 18].includes(numbers.length)) return socket.emit('betError', 'Tipo de apuesta inválido');

    const user = dbGet('SELECT balance FROM users WHERE id = ?', [socket.data.userId]);
    if (!user) return socket.emit('betError', 'Usuario no encontrado');

    if (amount > user.balance) return socket.emit('betError', 'Saldo insuficiente');

    // Deduct bet from balance immediately
    const newBalance = user.balance - amount;
    dbRun('UPDATE users SET balance = ? WHERE id = ?', [newBalance, socket.data.userId]);
    saveDB();

    const currentBets = roundBets.get(socket.id) || [];
    currentBets.push({ betKey, numbers, amount });
    roundBets.set(socket.id, currentBets);

    socket.emit('betOk', { betKey, amount, balance: newBalance });
    io.emit('betPlaced', { username: socket.data.username, amount });
  });

  socket.on('clearBets', () => {
    if (gamePhase !== 'betting') return;
    const bets = roundBets.get(socket.id);
    if (bets && bets.length > 0 && socket.data.userId) {
      // Refund all bets
      const totalRefund = bets.reduce((s, b) => s + b.amount, 0);
      const user = dbGet('SELECT balance FROM users WHERE id = ?', [socket.data.userId]);
      if (user) {
        const newBalance = user.balance + totalRefund;
        dbRun('UPDATE users SET balance = ? WHERE id = ?', [newBalance, socket.data.userId]);
        saveDB();
        socket.emit('betsCleared', { balance: newBalance });
      }
    } else if (socket.data.userId) {
      const user = dbGet('SELECT balance FROM users WHERE id = ?', [socket.data.userId]);
      socket.emit('betsCleared', { balance: user?.balance || 0 });
    }
    roundBets.delete(socket.id);
  });

  socket.on('disconnect', () => {});
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

initDB().then(() => {
  takeSnapshots();
  server.listen(PORT, () => {
    console.log(`Casino Amigos corriendo en http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Error starting:', err);
  process.exit(1);
});
