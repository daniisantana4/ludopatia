// ── Constants ────────────────────────────────────────────
const WHEEL_ORDER = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
const RED_NUMBERS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const CHIPS = [
  { value: 1, label: '1' },
  { value: 5, label: '5' },
  { value: 25, label: '25' },
  { value: 50, label: '50' },
  { value: 100, label: '100' },
  { value: 500, label: '500' },
  { value: 1000, label: '1K' },
  { value: 2500, label: '2.5K' },
];
const CHIP_COLORS = {
  1: '#e0e0e0', 5: '#e53935', 25: '#2e7d32', 50: '#1565c0',
  100: '#212121', 500: '#7b1fa2', 1000: '#e8a500', 2500: '#d81b60'
};

function tableNumber(row, col) { return (col + 1) * 3 - row; }
function getColor(n) { return n === 0 ? 'green' : RED_NUMBERS.has(n) ? 'red' : 'black'; }

// ── State ────────────────────────────────────────────────
let token = localStorage.getItem('casinoToken');
let socket = null;
let selectedChip = 5;
let balance = 0;
let currentPhase = 'waiting';
let placedBets = [];      // current round bets
let lastRoundBets = [];   // previous round bets for repeat
let lastWinningNumber = 0;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// Measure actual strip item width
function getStripItemWidth() {
  const item = $('.strip-num');
  if (!item) return 70;
  const gap = parseFloat(getComputedStyle($('.roulette-strip')).gap) || 6;
  return item.offsetWidth + gap;
}

// ── Auth ─────────────────────────────────────────────────
function initAuth() {
  $$('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.auth-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const isLogin = tab.dataset.tab === 'login';
      $('#loginForm').classList.toggle('hidden', !isLogin);
      $('#registerForm').classList.toggle('hidden', isLogin);
      $('#authError').textContent = '';
    });
  });
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('#loginUser').value.trim(), password: $('#loginPass').value }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      token = data.token; localStorage.setItem('casinoToken', token);
      enterGame(data.username, data.balance);
    } catch (err) { $('#authError').textContent = err.message; }
  });
  $('#registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('#regUser').value.trim(), password: $('#regPass').value }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      token = data.token; localStorage.setItem('casinoToken', token);
      enterGame(data.username, data.balance);
    } catch (err) { $('#authError').textContent = err.message; }
  });
  $('#logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('casinoToken'); token = null;
    if (socket) socket.disconnect();
    $('#authModal').classList.remove('hidden');
    $('#gameContainer').classList.add('hidden');
  });
}

function enterGame(username, bal) {
  $('#authModal').classList.add('hidden');
  $('#gameContainer').classList.remove('hidden');
  $('#username').textContent = username;
  balance = bal; updateBalanceDisplay();
  connectSocket();
}

// ── Socket.io ────────────────────────────────────────────
function connectSocket() {
  socket = io();
  socket.on('connect', () => { if (token) socket.emit('auth', token); });
  socket.on('authOk', (d) => { $('#username').textContent = d.username; balance = d.balance; updateBalanceDisplay(); });
  socket.on('authError', () => { localStorage.removeItem('casinoToken'); token = null; $('#authModal').classList.remove('hidden'); $('#gameContainer').classList.add('hidden'); });

  socket.on('gameState', (d) => {
    currentPhase = d.phase;
    lastWinningNumber = d.lastNumber || 0;
    if (d.history) renderHistory(d.history);
    updatePhaseUI(d.phase, d.timer);
    buildStrip(lastWinningNumber);
  });

  socket.on('phase', (d) => {
    const prev = currentPhase;
    currentPhase = d.phase;
    if (d.history) renderHistory(d.history);
    if (d.phase === 'spinning') {
      spinTo(d.number, d.lastNumber || lastWinningNumber);
    } else if (d.phase === 'result') {
      if (d.number !== undefined) highlightWinner(d.number);
    } else if (d.phase === 'betting' && prev === 'result') {
      // Save bets for repeat, then clear
      if (placedBets.length > 0) lastRoundBets = [...placedBets];
      clearLocalBets();
      clearWinnerHighlights();
    }
    updatePhaseUI(d.phase, d.timer);
  });

  socket.on('betOk', (d) => { balance = d.balance; updateBalanceDisplay(); });
  socket.on('betError', (msg) => {
    if (placedBets.length > 0) placedBets.pop();
    updateTotalBetDisplay();
    showToast(msg);
  });
  socket.on('balanceUpdate', (d) => { balance = d.balance; updateBalanceDisplay(); showPayout(d.payout, d.bet); });
  socket.on('betsCleared', (d) => { balance = d.balance; updateBalanceDisplay(); clearLocalBets(); });
}

function tryAutoLogin() {
  if (!token) return;
  $('#authModal').classList.add('hidden');
  $('#gameContainer').classList.remove('hidden');
  connectSocket();
}

// ── UI ───────────────────────────────────────────────────
function updateBalanceDisplay() { $('#balance').textContent = Math.floor(balance).toLocaleString('es-ES'); }

function updatePhaseUI(phase, timer) {
  $('.phase-display').className = 'phase-display ' + phase;
  const t = $('#phaseText'), tm = $('#phaseTimer');
  if (phase === 'betting') { t.textContent = '¡Hagan sus apuestas!'; tm.textContent = timer || ''; }
  else if (phase === 'spinning') { t.textContent = 'Girando...'; tm.textContent = ''; }
  else if (phase === 'result') { t.textContent = 'Resultado'; tm.textContent = timer || ''; }
  else { t.textContent = 'Esperando jugadores...'; tm.textContent = ''; }
}

function getTotalBet() { return placedBets.reduce((s, b) => s + b.amount, 0); }
function updateTotalBetDisplay() { $('#totalBetDisplay').textContent = getTotalBet().toLocaleString('es-ES'); }

function showPayout(payout, bet) {
  const n = $('#payoutNotif'), t = $('#payoutText');
  if (bet === 0) { n.classList.add('hidden'); return; }
  if (payout > 0) { n.className = 'payout-notif win'; t.textContent = `+${Math.floor(payout).toLocaleString('es-ES')} fichas`; }
  else { n.className = 'payout-notif lose'; t.textContent = `-${Math.floor(bet).toLocaleString('es-ES')} fichas`; }
  n.classList.remove('hidden');
  setTimeout(() => n.classList.add('hidden'), 3500);
}

function showToast(msg) {
  const n = $('#payoutNotif'), t = $('#payoutText');
  n.className = 'payout-notif lose'; t.textContent = msg;
  n.classList.remove('hidden');
  setTimeout(() => n.classList.add('hidden'), 2000);
}

// ── Roulette Strip ───────────────────────────────────────
function buildStrip(centerNumber) {
  const strip = $('#rouletteStrip');
  strip.style.transition = 'none';
  strip.innerHTML = '';
  const repeats = 15;
  for (let r = 0; r < repeats; r++) {
    for (const n of WHEEL_ORDER) {
      const el = document.createElement('div');
      el.className = `strip-num ${getColor(n)}`;
      el.textContent = n;
      el.dataset.number = n;
      strip.appendChild(el);
    }
  }
  requestAnimationFrame(() => {
    const itemW = getStripItemWidth();
    const idx = WHEEL_ORDER.indexOf(centerNumber);
    const center = Math.floor(repeats / 2) * WHEEL_ORDER.length + idx;
    const vw = $('.roulette-viewport').offsetWidth;
    strip.style.transform = `translateX(${-(center * itemW - vw / 2 + itemW / 2)}px)`;
  });
}

function spinTo(targetNumber, fromNumber) {
  const strip = $('#rouletteStrip');
  strip.style.transition = 'none';
  strip.innerHTML = '';
  const repeats = 15;
  for (let r = 0; r < repeats; r++) {
    for (const n of WHEEL_ORDER) {
      const el = document.createElement('div');
      el.className = `strip-num ${getColor(n)}`;
      el.textContent = n;
      el.dataset.number = n;
      strip.appendChild(el);
    }
  }
  requestAnimationFrame(() => {
    const itemW = getStripItemWidth();
    const vw = $('.roulette-viewport').offsetWidth;
    const fromIdx = WHEEL_ORDER.indexOf(fromNumber);
    const toIdx = WHEEL_ORDER.indexOf(targetNumber);
    const half = Math.floor(repeats / 2);
    const startCenter = half * WHEEL_ORDER.length + fromIdx;
    const startOff = startCenter * itemW - vw / 2 + itemW / 2;
    strip.style.transform = `translateX(${-startOff}px)`;
    void strip.offsetHeight; // force layout

    const extra = 3 * WHEEL_ORDER.length;
    let targetCenter = startCenter + extra;
    const rem = targetCenter % WHEEL_ORDER.length;
    const diff = toIdx - rem;
    targetCenter += diff >= 0 ? diff : diff + WHEEL_ORDER.length;
    const targetOff = targetCenter * itemW - vw / 2 + itemW / 2;
    const jitter = (Math.random() - 0.5) * 10;

    requestAnimationFrame(() => {
      strip.style.transition = 'transform 6s cubic-bezier(0.15, 0.85, 0.25, 1)';
      strip.style.transform = `translateX(${-(targetOff + jitter)}px)`;
    });
  });
  setTimeout(() => { lastWinningNumber = targetNumber; }, 6200);
}

function highlightWinner(number) {
  $$('.table-cell').forEach(c => {
    c.classList.remove('winner-cell');
    if (c.dataset.numbers) {
      const nums = JSON.parse(c.dataset.numbers);
      if (nums.length === 1 && nums[0] === number) c.classList.add('winner-cell');
    }
  });
  $$(`.strip-num[data-number="${number}"]`).forEach(el => el.classList.add('winner'));
}
function clearWinnerHighlights() {
  $$('.table-cell').forEach(c => c.classList.remove('winner-cell'));
  $$('.strip-num').forEach(c => c.classList.remove('winner'));
}

// ── History ──────────────────────────────────────────────
function renderHistory(history) {
  const c = $('#historyNumbers');
  c.innerHTML = '';
  for (const h of history) {
    const el = document.createElement('div');
    el.className = `hist-num ${h.color}`;
    el.textContent = h.number;
    c.appendChild(el);
  }
}

// ── Chip Selector ────────────────────────────────────────
function initChips() {
  const list = $('#chipList');
  for (const chip of CHIPS) {
    const el = document.createElement('div');
    el.className = 'chip' + (chip.value === selectedChip ? ' selected' : '');
    el.dataset.value = chip.value;
    el.textContent = chip.label;
    el.addEventListener('click', () => {
      $$('.chip').forEach(c => c.classList.remove('selected'));
      el.classList.add('selected');
      selectedChip = chip.value;
    });
    list.appendChild(el);
  }
  $('#clearBetsBtn').addEventListener('click', () => {
    if (socket && currentPhase === 'betting') socket.emit('clearBets');
  });
  $('#repeatBetBtn').addEventListener('click', repeatLastBet);
}

// ── Repeat last bet ──────────────────────────────────────
function repeatLastBet() {
  if (currentPhase !== 'betting') { showToast('Espera a la ronda de apuestas'); return; }
  if (!socket || !token) return;
  if (lastRoundBets.length === 0) { showToast('No hay apuesta anterior'); return; }

  const totalNeeded = lastRoundBets.reduce((s, b) => s + b.amount, 0);
  if (totalNeeded > balance) { showToast('Saldo insuficiente para repetir'); return; }

  for (const bet of lastRoundBets) {
    socket.emit('placeBet', { betKey: bet.betKey, numbers: bet.numbers, amount: bet.amount });
    placedBets.push({ ...bet });
    balance -= bet.amount;
    updateBalanceDisplay();
    updateTotalBetDisplay();
    // Show bet indicator on the matching cell
    const cell = findCellForBet(bet.numbers);
    if (cell) renderBetIndicator(cell, bet.amount, bet.chipValue);
  }
}

function findCellForBet(numbers) {
  // For straight bets and outside bets, find the matching cell
  const key = JSON.stringify(numbers.sort((a,b) => a-b));
  const cells = $$('.table-cell[data-numbers]');
  for (const c of cells) {
    if (c.dataset.numbers === key) return c;
  }
  // For splits/corners, find the hotspot
  const hotspots = $$('.bet-hotspot[data-numbers]');
  for (const h of hotspots) {
    if (h.dataset.numbers === key) return h;
  }
  return null;
}

// ── Roulette Table ───────────────────────────────────────
function buildTable() {
  const table = $('#rouletteTable');
  table.innerHTML = '';

  // Zero
  const zero = createCell([0], '0', 'green-cell zero-cell');
  zero.style.gridRow = '1 / 4'; zero.style.gridColumn = '1';
  table.appendChild(zero);

  // Number cells
  for (let col = 0; col < 12; col++) {
    for (let row = 0; row < 3; row++) {
      const num = tableNumber(row, col);
      const color = getColor(num);
      const cell = createCell([num], String(num), `${color === 'red' ? 'red' : 'black'}-cell`);
      cell.style.gridRow = String(row + 1);
      cell.style.gridColumn = String(col + 2);
      cell.dataset.row = row;
      cell.dataset.col = col;
      // Straight bet on center click
      cell.addEventListener('click', () => placeBet([num], cell, 'straight', selectedChip));
      table.appendChild(cell);
    }
  }

  // Column bets (2:1)
  for (let row = 0; row < 3; row++) {
    const nums = [];
    for (let col = 0; col < 12; col++) nums.push(tableNumber(row, col));
    const cell = createCell(nums, '2:1', 'outside col-bet');
    cell.style.gridRow = String(row + 1); cell.style.gridColumn = '14';
    table.appendChild(cell);
  }

  // Dozen bets
  const doz = [[1,12],[13,24],[25,36]];
  const dozL = ['1ª Doc', '2ª Doc', '3ª Doc'];
  for (let i = 0; i < 3; i++) {
    const nums = []; for (let n = doz[i][0]; n <= doz[i][1]; n++) nums.push(n);
    const cell = createCell(nums, dozL[i], 'outside dozen-bet');
    cell.style.gridRow = '4'; cell.style.gridColumn = `${i * 4 + 2} / ${i * 4 + 6}`;
    table.appendChild(cell);
  }

  // Bottom outside bets
  const outside = [
    { label: '1-18', nums: Array.from({length:18}, (_,i) => i+1) },
    { label: 'PAR', nums: Array.from({length:18}, (_,i) => (i+1)*2) },
    { label: '◆', nums: [...RED_NUMBERS], cls: 'red-cell' },
    { label: '◆', nums: Array.from({length:36}, (_,i) => i+1).filter(n => !RED_NUMBERS.has(n)), cls: 'black-cell' },
    { label: 'IMPAR', nums: Array.from({length:18}, (_,i) => i*2+1) },
    { label: '19-36', nums: Array.from({length:18}, (_,i) => i+19) },
  ];
  for (let i = 0; i < outside.length; i++) {
    const b = outside[i];
    const cell = createCell(b.nums, b.label, `outside outside-bottom ${b.cls || ''}`);
    cell.style.gridRow = '5';
    cell.style.gridColumn = `${i * 2 + 2} / ${i * 2 + 4}`;
    table.appendChild(cell);
  }

  // Fillers
  for (const r of ['4','5']) for (const c of ['1','14']) {
    const e = document.createElement('div');
    e.style.gridRow = r; e.style.gridColumn = c;
    table.appendChild(e);
  }

  // Add split/corner hotspots after layout settles
  requestAnimationFrame(() => setTimeout(addBetHotspots, 50));
}

function createCell(numbers, label, extraClass) {
  const cell = document.createElement('div');
  cell.className = `table-cell ${extraClass || ''}`;
  cell.textContent = label;
  cell.dataset.numbers = JSON.stringify(numbers);
  // Outside bets & zero: click handler
  if (extraClass && (extraClass.includes('outside') || extraClass.includes('zero'))) {
    cell.addEventListener('click', () => placeBet(numbers, cell, 'outside', selectedChip));
  }
  return cell;
}

// ── Bet hotspot overlays for splits and corners ──────────
function addBetHotspots() {
  $$('.bet-hotspot').forEach(el => el.remove());

  const table = $('#rouletteTable');
  const tRect = table.getBoundingClientRect();

  // Build cell position map
  const cells = {};
  $$('.table-cell[data-row]').forEach(cell => {
    const r = parseInt(cell.dataset.row);
    const c = parseInt(cell.dataset.col);
    const rect = cell.getBoundingClientRect();
    cells[`${r},${c}`] = {
      num: tableNumber(r, c),
      l: rect.left - tRect.left,
      t: rect.top - tRect.top,
      w: rect.width,
      h: rect.height
    };
  });

  const Z = Math.max(10, (cells['0,0']?.w || 52) * 0.22); // hotspot half-size, scales with cell

  // Horizontal splits (between left-right neighbors in same row)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 11; c++) {
      const a = cells[`${r},${c}`], b = cells[`${r},${c+1}`];
      if (!a || !b) continue;
      const nums = [a.num, b.num].sort((x,y) => x-y);
      createHotspot(table, a.l + a.w - Z, a.t + Z * 0.5, Z * 2, a.h - Z, nums);
    }
  }

  // Vertical splits (between top-bottom neighbors in same column)
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 12; c++) {
      const a = cells[`${r},${c}`], b = cells[`${r+1},${c}`];
      if (!a || !b) continue;
      const nums = [a.num, b.num].sort((x,y) => x-y);
      createHotspot(table, a.l + Z * 0.5, a.t + a.h - Z, a.w - Z, Z * 2, nums);
    }
  }

  // Corners (at intersection of 4 numbers)
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 11; c++) {
      const tl = cells[`${r},${c}`], tr = cells[`${r},${c+1}`];
      const bl = cells[`${r+1},${c}`], br = cells[`${r+1},${c+1}`];
      if (!tl || !tr || !bl || !br) continue;
      const nums = [tl.num, tr.num, bl.num, br.num].sort((x,y) => x-y);
      createHotspot(table, tl.l + tl.w - Z, tl.t + tl.h - Z, Z * 2, Z * 2, nums);
    }
  }
}

function createHotspot(parent, x, y, w, h, numbers) {
  const el = document.createElement('div');
  el.className = 'bet-hotspot';
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.width = w + 'px';
  el.style.height = h + 'px';
  el.dataset.numbers = JSON.stringify(numbers);
  el.title = numbers.join(', ');
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    placeBet(numbers, el, 'split', selectedChip);
  });
  parent.appendChild(el);
}

// Recalculate hotspots on resize
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(addBetHotspots, 200);
});

// ── Place bet ────────────────────────────────────────────
function placeBet(numbers, cell, betType, chipVal) {
  if (currentPhase !== 'betting') { showToast('Espera a la ronda de apuestas'); return; }
  if (!socket || !token) return;

  const amount = chipVal || selectedChip;
  if (amount > balance) { showToast('Saldo insuficiente'); return; }

  const betKey = [...numbers].sort((a,b) => a-b).join(',');
  socket.emit('placeBet', { betKey, numbers: [...numbers], amount });

  placedBets.push({ betKey, numbers: [...numbers], amount, chipValue: amount });
  balance -= amount;
  updateBalanceDisplay();
  updateTotalBetDisplay();
  renderBetIndicator(cell, amount, chipVal || selectedChip);
}

function renderBetIndicator(cell, amount, chipVal) {
  const existing = cell.querySelector('.bet-indicator');
  if (existing) {
    const cur = parseInt(existing.dataset.totalAmount || '0');
    const nw = cur + amount;
    existing.dataset.totalAmount = nw;
    existing.textContent = nw >= 1000 ? Math.floor(nw/1000) + 'K' : nw;
    return;
  }
  const ind = document.createElement('div');
  ind.className = 'bet-indicator';
  ind.style.background = CHIP_COLORS[chipVal] || '#888';
  if (chipVal === 1 || chipVal === 1000) ind.style.color = '#333';
  ind.textContent = amount >= 1000 ? Math.floor(amount/1000) + 'K' : amount;
  ind.dataset.totalAmount = amount;
  ind.style.top = '50%'; ind.style.left = '50%';
  ind.style.transform = 'translate(-50%, -50%)';
  cell.style.position = 'relative';
  cell.appendChild(ind);
}

function clearLocalBets() {
  placedBets = [];
  updateTotalBetDisplay();
  $$('.bet-indicator').forEach(el => el.remove());
}

// ── Leaderboard ──────────────────────────────────────────
function initLeaderboard() {
  $('#leaderboardBtn').addEventListener('click', () => { $('#leaderboardModal').classList.remove('hidden'); loadLeaderboard('alltime'); });
  $('#closeLeaderboard').addEventListener('click', () => { $('#leaderboardModal').classList.add('hidden'); });
  $('#leaderboardModal').addEventListener('click', (e) => { if (e.target === $('#leaderboardModal')) $('#leaderboardModal').classList.add('hidden'); });
  $$('.lb-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.lb-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      loadLeaderboard(tab.dataset.lb);
    });
  });
}

async function loadLeaderboard(type) {
  const body = $('#leaderboardBody');
  body.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-dim)">Cargando...</div>';
  try {
    const res = await fetch(`/api/leaderboard/${type}`);
    const data = await res.json();
    body.innerHTML = '';
    if (data.length === 0) { body.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-dim)">Sin datos</div>'; return; }
    data.forEach((row, i) => {
      const el = document.createElement('div');
      el.className = 'lb-row';
      const medals = ['👑', '🥈', '🥉'];
      const rank = i < 3 ? medals[i] : `${i + 1}`;
      let val;
      if (type === 'alltime') {
        val = `<span class="lb-balance">${Math.floor(row.balance).toLocaleString('es-ES')}</span>`;
      } else {
        const p = Math.floor(row.profit || 0);
        val = `<span class="lb-balance">${Math.floor(row.balance).toLocaleString('es-ES')}</span>
               <span class="lb-profit ${p >= 0 ? 'positive' : 'negative'}">${p >= 0 ? '+' : ''}${p.toLocaleString('es-ES')}</span>`;
      }
      el.innerHTML = `<span class="lb-rank">${rank}</span><span class="lb-name">${escapeHtml(row.username)}</span>${val}`;
      body.appendChild(el);
    });
  } catch { body.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-dim)">Error al cargar</div>'; }
}

function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ── Init ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initAuth();
  initChips();
  buildTable();
  initLeaderboard();
  buildStrip(0);
  if (token) tryAutoLogin();
});
