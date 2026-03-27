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

// Serve admin explicitly in case of issues
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const DB_PATH = path.join(__dirname, 'casino.db');
let db;
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123';

async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) { db = new SQL.Database(fs.readFileSync(DB_PATH)); }
  else { db = new SQL.Database(); }
  db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL COLLATE NOCASE, password_hash TEXT NOT NULL, balance REAL DEFAULT 1000, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS rounds (id INTEGER PRIMARY KEY AUTOINCREMENT, winning_number INTEGER NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS bet_history (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, round_id INTEGER NOT NULL, total_bet REAL DEFAULT 0, total_payout REAL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS balance_snapshots (user_id INTEGER NOT NULL, balance REAL NOT NULL, snapshot_date TEXT NOT NULL, PRIMARY KEY(user_id, snapshot_date))`);
  saveDB();
}

function saveDB() { try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); } catch(e) { console.error('DB save error:', e); } }
function dbAll(sql, p=[]) { const s=db.prepare(sql); if(p.length) s.bind(p); const r=[]; while(s.step()) r.push(s.getAsObject()); s.free(); return r; }
function dbGet(sql, p=[]) { const r=dbAll(sql,p); return r[0]||null; }
function dbRun(sql, p=[]) { db.run(sql,p); }
function dbLastId() { return dbGet('SELECT last_insert_rowid() as id')?.id||0; }

const sessions = new Map();
const WHEEL_ORDER = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
const RED_NUMBERS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
function getColor(n) { return n===0?'green':RED_NUMBERS.has(n)?'red':'black'; }

let gamePhase = 'waiting', phaseTimer = 3, winningNumber = null, lastWinningNumber = 0;
const roundBets = new Map();
const resultHistory = [];
const BETTING_TIME = 30;
const PAYOUT_MAP = { 1:35, 2:17, 3:11, 4:8, 6:5, 12:2, 18:1 };

function calculatePayouts() {
  dbRun('INSERT INTO rounds (winning_number) VALUES (?)', [winningNumber]);
  const roundId = dbLastId();
  const payouts = {};
  const roundWinners = []; // For the round results table

  for (const [socketId, userBets] of roundBets.entries()) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket || !socket.data.userId) continue;
    const userId = socket.data.userId;
    let totalBet = 0, totalPayout = 0;

    for (const bet of userBets) {
      totalBet += bet.amount;
      if (bet.numbers.includes(winningNumber)) {
        const ratio = PAYOUT_MAP[bet.numbers.length];
        if (ratio !== undefined) totalPayout += bet.amount + bet.amount * ratio;
      }
    }

    const user = dbGet('SELECT balance FROM users WHERE id = ?', [userId]);
    if (user) {
      const newBalance = user.balance + totalPayout;
      dbRun('UPDATE users SET balance = ? WHERE id = ?', [newBalance, userId]);
      payouts[socketId] = { userId, totalBet, totalPayout, newBalance, username: socket.data.username };

      // Track winners for the round results table
      if (totalPayout > 0) {
        roundWinners.push({ username: socket.data.username, payout: totalPayout, bet: totalBet, profit: totalPayout - totalBet });
      }
    }
    dbRun('INSERT INTO bet_history (user_id, round_id, total_bet, total_payout) VALUES (?,?,?,?)', [userId, roundId, totalBet, totalPayout]);
  }
  saveDB();

  // Sort winners by profit descending
  roundWinners.sort((a, b) => b.profit - a.profit);

  return { payouts, roundWinners };
}

function takeSnapshots() {
  if (!db) return;
  const today = new Date().toISOString().slice(0,10);
  const users = dbAll('SELECT id, balance FROM users');
  for (const u of users) dbRun('INSERT OR IGNORE INTO balance_snapshots (user_id, balance, snapshot_date) VALUES (?,?,?)', [u.id, u.balance, today]);
  saveDB();
}

function gameLoop() {
  if (!db) return;
  if (io.sockets.sockets.size === 0 && gamePhase === 'waiting') return;

  if (gamePhase === 'waiting') {
    let hasAuth = false;
    for (const [,s] of io.sockets.sockets) { if (s.data.userId) { hasAuth=true; break; } }
    if (!hasAuth) return;
    gamePhase = 'betting'; phaseTimer = BETTING_TIME;
    io.emit('phase', { phase: 'betting', timer: phaseTimer });
    return;
  }

  if (gamePhase === 'betting') {
    phaseTimer--;
    if (phaseTimer <= 0) {
      winningNumber = Math.floor(Math.random() * 37);
      gamePhase = 'spinning'; phaseTimer = 7;
      io.emit('phase', { phase: 'spinning', timer: phaseTimer, number: winningNumber, lastNumber: lastWinningNumber });
    } else {
      io.emit('phase', { phase: 'betting', timer: phaseTimer });
    }
  } else if (gamePhase === 'spinning') {
    phaseTimer--;
    if (phaseTimer <= 0) {
      gamePhase = 'result'; phaseTimer = 5;
      const { payouts, roundWinners } = calculatePayouts();
      resultHistory.unshift({ number: winningNumber, color: getColor(winningNumber) });
      if (resultHistory.length > 20) resultHistory.pop();
      io.emit('phase', { phase: 'result', timer: phaseTimer, number: winningNumber, payouts, history: resultHistory, roundWinners });
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
      gamePhase = 'betting'; phaseTimer = BETTING_TIME;
      io.emit('phase', { phase: 'betting', timer: phaseTimer, history: resultHistory });
    } else {
      io.emit('phase', { phase: 'result', timer: phaseTimer });
    }
  }
}
setInterval(gameLoop, 1000);

// Auth
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Faltan campos' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Usuario: 3-20 caracteres' });
  if (password.length < 4) return res.status(400).json({ error: 'Contraseña: mín. 4 caracteres' });
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Solo letras, números y _' });
  if (dbGet('SELECT id FROM users WHERE username = ?', [username])) return res.status(400).json({ error: 'El usuario ya existe' });
  dbRun('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, bcrypt.hashSync(password, 10)]);
  const userId = dbLastId();
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, username });
  saveDB(); takeSnapshots();
  res.json({ token, username, balance: 1000 });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Faltan campos' });
  const user = dbGet('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Credenciales incorrectas' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: user.id, username: user.username });
  res.json({ token, username: user.username, balance: user.balance });
});

// Leaderboard
app.get('/api/leaderboard/:type', (req, res) => {
  const type = req.params.type;
  if (type === 'alltime') return res.json(dbAll('SELECT username, balance FROM users ORDER BY balance DESC LIMIT 50'));
  const now = new Date(); let dateStr;
  if (type === 'daily') { dateStr = now.toISOString().slice(0,10); }
  else if (type === 'weekly') { const d=now.getDay(); const m=new Date(now); m.setDate(now.getDate()-((d+6)%7)); dateStr=m.toISOString().slice(0,10); }
  else return res.status(400).json({ error: 'Tipo inválido' });
  res.json(dbAll(`SELECT u.username, u.balance, u.balance - COALESCE(s.balance, 1000) as profit FROM users u LEFT JOIN balance_snapshots s ON u.id = s.user_id AND s.snapshot_date = ? ORDER BY profit DESC LIMIT 50`, [dateStr]));
});

// Admin
function checkAdmin(req, res) { const k=req.query.key||req.headers['x-admin-key']; if(k!==ADMIN_KEY){res.status(403).json({error:'Clave admin incorrecta'});return false;} return true; }
app.get('/api/admin/users', (req, res) => { if(!checkAdmin(req,res)) return; res.json(dbAll('SELECT id, username, balance, created_at FROM users ORDER BY balance DESC')); });
app.put('/api/admin/users/:id/balance', (req, res) => {
  if(!checkAdmin(req,res)) return;
  const { balance } = req.body;
  if(balance===undefined||isNaN(balance)) return res.status(400).json({error:'Balance inválido'});
  if(!dbGet('SELECT id FROM users WHERE id = ?',[req.params.id])) return res.status(404).json({error:'No encontrado'});
  dbRun('UPDATE users SET balance = ? WHERE id = ?', [Number(balance), req.params.id]); saveDB();
  for(const[,s]of io.sockets.sockets){if(s.data.userId==req.params.id)s.emit('balanceUpdate',{balance:Number(balance),payout:0,bet:0});}
  res.json({ok:true});
});
app.delete('/api/admin/users/:id', (req, res) => {
  if(!checkAdmin(req,res)) return;
  if(!dbGet('SELECT id FROM users WHERE id = ?',[req.params.id])) return res.status(404).json({error:'No encontrado'});
  dbRun('DELETE FROM bet_history WHERE user_id = ?',[req.params.id]);
  dbRun('DELETE FROM balance_snapshots WHERE user_id = ?',[req.params.id]);
  dbRun('DELETE FROM users WHERE id = ?',[req.params.id]); saveDB();
  for(const[,s]of io.sockets.sockets){if(s.data.userId==req.params.id)s.emit('authError','Cuenta eliminada');}
  res.json({ok:true});
});
app.post('/api/admin/users/:id/reset', (req, res) => {
  if(!checkAdmin(req,res)) return;
  if(!dbGet('SELECT id FROM users WHERE id = ?',[req.params.id])) return res.status(404).json({error:'No encontrado'});
  dbRun('UPDATE users SET balance = 1000 WHERE id = ?',[req.params.id]); saveDB();
  for(const[,s]of io.sockets.sockets){if(s.data.userId==req.params.id)s.emit('balanceUpdate',{balance:1000,payout:0,bet:0});}
  res.json({ok:true});
});

// Socket.io
io.on('connection', (socket) => {
  socket.emit('gameState', { phase: gamePhase, timer: phaseTimer, history: resultHistory, lastNumber: lastWinningNumber });
  socket.on('auth', (token) => {
    const session = sessions.get(token);
    if (!session) return socket.emit('authError', 'Sesión inválida');
    socket.data.userId = session.userId; socket.data.username = session.username;
    const user = dbGet('SELECT balance FROM users WHERE id = ?', [session.userId]);
    socket.emit('authOk', { username: session.username, balance: user?.balance || 0 });
    if (gamePhase === 'waiting') { gamePhase = 'betting'; phaseTimer = BETTING_TIME; io.emit('phase', { phase: 'betting', timer: phaseTimer, history: resultHistory }); }
  });
  socket.on('placeBet', (data) => {
    if (gamePhase !== 'betting') return socket.emit('betError', 'No se aceptan apuestas ahora');
    if (!socket.data.userId) return socket.emit('betError', 'No autenticado');
    const { betKey, numbers, amount } = data;
    if (!Array.isArray(numbers)||numbers.length===0||amount<=0) return socket.emit('betError', 'Apuesta inválida');
    if (![1,2,3,4,6,12,18].includes(numbers.length)) return socket.emit('betError', 'Tipo de apuesta inválido');
    const user = dbGet('SELECT balance FROM users WHERE id = ?', [socket.data.userId]);
    if (!user) return socket.emit('betError', 'Usuario no encontrado');
    if (amount > user.balance) return socket.emit('betError', 'Saldo insuficiente');
    const newBal = user.balance - amount;
    dbRun('UPDATE users SET balance = ? WHERE id = ?', [newBal, socket.data.userId]); saveDB();
    const cur = roundBets.get(socket.id) || [];
    cur.push({ betKey, numbers, amount }); roundBets.set(socket.id, cur);
    socket.emit('betOk', { betKey, amount, balance: newBal });
    io.emit('betPlaced', { username: socket.data.username, amount });
  });
  socket.on('clearBets', () => {
    if (gamePhase !== 'betting') return;
    const bets = roundBets.get(socket.id);
    if (bets && bets.length > 0 && socket.data.userId) {
      const refund = bets.reduce((s,b) => s+b.amount, 0);
      const user = dbGet('SELECT balance FROM users WHERE id = ?', [socket.data.userId]);
      if (user) { const nb = user.balance+refund; dbRun('UPDATE users SET balance = ? WHERE id = ?',[nb,socket.data.userId]); saveDB(); socket.emit('betsCleared',{balance:nb}); }
    } else if (socket.data.userId) { const u=dbGet('SELECT balance FROM users WHERE id = ?',[socket.data.userId]); socket.emit('betsCleared',{balance:u?.balance||0}); }
    roundBets.delete(socket.id);
  });
  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;
initDB().then(() => { takeSnapshots(); server.listen(PORT, () => console.log(`Casino Amigos en http://localhost:${PORT}`)); }).catch(e => { console.error(e); process.exit(1); });
