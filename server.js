const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Database ──────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'casino.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    balance REAL DEFAULT 1000,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    winning_number INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS bet_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    round_id INTEGER NOT NULL,
    total_bet REAL DEFAULT 0,
    total_payout REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS balance_snapshots (
    user_id INTEGER NOT NULL,
    balance REAL NOT NULL,
    snapshot_date TEXT NOT NULL,
    PRIMARY KEY(user_id, snapshot_date)
  );
`);

// ── Sessions ──────────────────────────────────────────────
const sessions = new Map(); // token -> { userId, username }

// ── Roulette data ─────────────────────────────────────────
const WHEEL_ORDER = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
const RED_NUMBERS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

function getColor(n) {
  if (n === 0) return 'green';
  return RED_NUMBERS.has(n) ? 'red' : 'black';
}

// ── Game state ────────────────────────────────────────────
let gamePhase = 'waiting'; // waiting, betting, spinning, result
let phaseTimer = 3;
let winningNumber = null;
let lastWinningNumber = 0;
const roundBets = new Map(); // odekId -> [{ betKey, numbers, amount }]
const resultHistory = [];

// Payout ratios based on how many numbers a bet covers
const PAYOUT_MAP = { 1: 35, 2: 17, 3: 11, 4: 8, 6: 5, 12: 2, 18: 1 };

function calculatePayouts() {
  const stmtGetUser = db.prepare('SELECT balance FROM users WHERE id = ?');
  const stmtUpdateBalance = db.prepare('UPDATE users SET balance = ? WHERE id = ?');
  const roundRow = db.prepare('INSERT INTO rounds (winning_number) VALUES (?)').run(winningNumber);
  const roundId = roundRow.lastInsertRowid;
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
        const payout = bet.amount + bet.amount * ratio;
        totalPayout += payout;
      }
    }

    const user = stmtGetUser.get(userId);
    if (user) {
      const newBalance = user.balance + totalPayout;
      stmtUpdateBalance.run(newBalance, userId);
      payouts[socketId] = { userId, totalBet, totalPayout, newBalance, username: socket.data.username };
    }

    db.prepare('INSERT INTO bet_history (user_id, round_id, total_bet, total_payout) VALUES (?,?,?,?)')
      .run(userId, roundId, totalBet, totalPayout);
  }
  return payouts;
}

function takeSnapshots() {
  const today = new Date().toISOString().slice(0, 10);
  const users = db.prepare('SELECT id, balance FROM users').all();
  const stmt = db.prepare('INSERT OR IGNORE INTO balance_snapshots (user_id, balance, snapshot_date) VALUES (?,?,?)');
  const txn = db.transaction(() => {
    for (const u of users) stmt.run(u.id, u.balance, today);
  });
  txn();
}

// Take snapshot on server start
takeSnapshots();
// Take snapshot every hour
setInterval(takeSnapshots, 3600000);

// ── Game loop ─────────────────────────────────────────────
function gameLoop() {
  if (io.sockets.sockets.size === 0 && gamePhase === 'waiting') return;

  if (gamePhase === 'waiting') {
    // Check if any authenticated users are connected
    let hasAuth = false;
    for (const [, s] of io.sockets.sockets) { if (s.data.userId) { hasAuth = true; break; } }
    if (!hasAuth) return;
    gamePhase = 'betting';
    phaseTimer = 10;
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
      // Send updated balance to each user
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
      phaseTimer = 10;
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

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(400).json({ error: 'El usuario ya existe' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: result.lastInsertRowid, username });
  takeSnapshots();
  res.json({ token, username, balance: 1000 });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Faltan campos' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
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
    const rows = db.prepare('SELECT username, balance FROM users ORDER BY balance DESC LIMIT 50').all();
    return res.json(rows);
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

  const rows = db.prepare(`
    SELECT u.username, u.balance, u.balance - COALESCE(s.balance, 1000) as profit
    FROM users u
    LEFT JOIN balance_snapshots s ON u.id = s.user_id AND s.snapshot_date = ?
    ORDER BY profit DESC
    LIMIT 50
  `).all(dateStr);
  res.json(rows);
});

// ── Socket.io ─────────────────────────────────────────────
io.on('connection', (socket) => {
  // Send current game state
  socket.emit('gameState', { phase: gamePhase, timer: phaseTimer, history: resultHistory, lastNumber: lastWinningNumber });

  socket.on('auth', (token) => {
    const session = sessions.get(token);
    if (!session) return socket.emit('authError', 'Sesión inválida');
    socket.data.userId = session.userId;
    socket.data.username = session.username;
    const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(session.userId);
    socket.emit('authOk', { username: session.username, balance: user?.balance || 0 });
    // If we were waiting for players, kick off the game
    if (gamePhase === 'waiting') {
      gamePhase = 'betting';
      phaseTimer = 10;
      io.emit('phase', { phase: 'betting', timer: phaseTimer, history: resultHistory });
    }
  });

  socket.on('placeBet', (data) => {
    if (gamePhase !== 'betting') return socket.emit('betError', 'No se aceptan apuestas ahora');
    if (!socket.data.userId) return socket.emit('betError', 'No autenticado');

    const { betKey, numbers, amount } = data;
    if (!Array.isArray(numbers) || numbers.length === 0 || amount <= 0) return socket.emit('betError', 'Apuesta inválida');
    if (![1, 2, 3, 4, 6, 12, 18].includes(numbers.length)) return socket.emit('betError', 'Tipo de apuesta inválido');

    // Check balance
    const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(socket.data.userId);
    if (!user) return socket.emit('betError', 'Usuario no encontrado');

    const currentBets = roundBets.get(socket.id) || [];
    const totalBet = currentBets.reduce((s, b) => s + b.amount, 0) + amount;
    if (totalBet > user.balance) return socket.emit('betError', 'Saldo insuficiente');

    currentBets.push({ betKey, numbers, amount });
    roundBets.set(socket.id, currentBets);
    socket.emit('betOk', { betKey, amount, remainingBalance: user.balance - totalBet });
    // Broadcast that someone bet (for visual feedback)
    io.emit('betPlaced', { username: socket.data.username, amount });
  });

  socket.on('clearBets', () => {
    if (gamePhase !== 'betting') return;
    roundBets.delete(socket.id);
    if (socket.data.userId) {
      const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(socket.data.userId);
      socket.emit('betsCleared', { balance: user?.balance || 0 });
    }
  });

  socket.on('disconnect', () => {
    // Bets remain if they were placed
  });
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎰 Casino Amigos corriendo en http://localhost:${PORT}`);
});
