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
function getColor(n) {
  if (n === 0) return 'green';
  return RED_NUMBERS.has(n) ? 'red' : 'black';
}

// ── State ────────────────────────────────────────────────
let token = localStorage.getItem('casinoToken');
let socket = null;
let selectedChip = 5;
let balance = 0;
let currentPhase = 'waiting';
let placedBets = [];
let lastWinningNumber = 0;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── Measure actual strip item width dynamically ──────────
function getStripItemWidth() {
  const firstItem = $('.strip-num');
  if (!firstItem) return 70;
  const style = getComputedStyle($('.roulette-strip'));
  const gap = parseFloat(style.gap) || 6;
  return firstItem.offsetWidth + gap;
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
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('#loginUser').value.trim(), password: $('#loginPass').value })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      token = data.token;
      localStorage.setItem('casinoToken', token);
      enterGame(data.username, data.balance);
    } catch (err) { $('#authError').textContent = err.message; }
  });

  $('#registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('#regUser').value.trim(), password: $('#regPass').value })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      token = data.token;
      localStorage.setItem('casinoToken', token);
      enterGame(data.username, data.balance);
    } catch (err) { $('#authError').textContent = err.message; }
  });

  $('#logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('casinoToken');
    token = null;
    if (socket) socket.disconnect();
    $('#authModal').classList.remove('hidden');
    $('#gameContainer').classList.add('hidden');
  });
}

function enterGame(username, bal) {
  $('#authModal').classList.add('hidden');
  $('#gameContainer').classList.remove('hidden');
  $('#username').textContent = username;
  balance = bal;
  updateBalanceDisplay();
  connectSocket();
}

// ── Socket.io ────────────────────────────────────────────
function connectSocket() {
  socket = io();

  socket.on('connect', () => {
    if (token) socket.emit('auth', token);
  });

  socket.on('authOk', (data) => {
    $('#username').textContent = data.username;
    balance = data.balance;
    updateBalanceDisplay();
  });

  socket.on('authError', () => {
    localStorage.removeItem('casinoToken');
    token = null;
    $('#authModal').classList.remove('hidden');
    $('#gameContainer').classList.add('hidden');
  });

  socket.on('gameState', (data) => {
    currentPhase = data.phase;
    lastWinningNumber = data.lastNumber || 0;
    if (data.history) renderHistory(data.history);
    updatePhaseUI(data.phase, data.timer);
    buildStrip(lastWinningNumber);
  });

  socket.on('phase', (data) => {
    const prevPhase = currentPhase;
    currentPhase = data.phase;

    if (data.history) renderHistory(data.history);

    if (data.phase === 'spinning') {
      spinTo(data.number, data.lastNumber || lastWinningNumber);
    } else if (data.phase === 'result') {
      if (data.number !== undefined) highlightWinner(data.number);
    } else if (data.phase === 'betting') {
      if (prevPhase === 'result') {
        clearLocalBets();
        clearWinnerHighlights();
      }
    }
    updatePhaseUI(data.phase, data.timer);
  });

  socket.on('betOk', (data) => {
    // Server confirmed bet and deducted balance
    balance = data.balance;
    updateBalanceDisplay();
  });

  socket.on('betError', (msg) => {
    // Remove the last optimistic bet since server rejected it
    if (placedBets.length > 0) {
      placedBets.pop();
      updateTotalBetDisplay();
    }
    showToast(msg);
  });

  socket.on('balanceUpdate', (data) => {
    balance = data.balance;
    updateBalanceDisplay();
    showPayout(data.payout, data.bet);
  });

  socket.on('betsCleared', (data) => {
    balance = data.balance;
    updateBalanceDisplay();
    clearLocalBets();
  });
}

function tryAutoLogin() {
  if (!token) return;
  $('#authModal').classList.add('hidden');
  $('#gameContainer').classList.remove('hidden');
  connectSocket();
}

// ── UI Updates ───────────────────────────────────────────
function updateBalanceDisplay() {
  $('#balance').textContent = Math.floor(balance).toLocaleString('es-ES');
}

function updatePhaseUI(phase, timer) {
  const display = $('.phase-display');
  display.className = 'phase-display ' + phase;
  const text = $('#phaseText');
  const timerEl = $('#phaseTimer');

  if (phase === 'betting') {
    text.textContent = '¡Hagan sus apuestas!';
    timerEl.textContent = timer || '';
  } else if (phase === 'spinning') {
    text.textContent = 'Girando...';
    timerEl.textContent = '';
  } else if (phase === 'result') {
    text.textContent = 'Resultado';
    timerEl.textContent = timer || '';
  } else {
    text.textContent = 'Esperando jugadores...';
    timerEl.textContent = '';
  }
}

function getTotalBet() {
  return placedBets.reduce((s, b) => s + b.amount, 0);
}

function updateTotalBetDisplay() {
  $('#totalBetDisplay').textContent = getTotalBet().toLocaleString('es-ES');
}

function showPayout(payout, bet) {
  const notif = $('#payoutNotif');
  const text = $('#payoutText');

  if (bet === 0) {
    notif.classList.add('hidden');
    return;
  }

  if (payout > 0) {
    notif.className = 'payout-notif win';
    text.textContent = `+${Math.floor(payout).toLocaleString('es-ES')} fichas`;
  } else {
    notif.className = 'payout-notif lose';
    text.textContent = `-${Math.floor(bet).toLocaleString('es-ES')} fichas`;
  }
  notif.classList.remove('hidden');
  setTimeout(() => notif.classList.add('hidden'), 3500);
}

function showToast(msg) {
  const notif = $('#payoutNotif');
  const text = $('#payoutText');
  notif.className = 'payout-notif lose';
  text.textContent = msg;
  notif.classList.remove('hidden');
  setTimeout(() => notif.classList.add('hidden'), 2000);
}

// ── Roulette Strip ───────────────────────────────────────
function buildStrip(centerNumber) {
  const strip = $('#rouletteStrip');
  strip.classList.remove('spinning');
  strip.style.transition = 'none';
  strip.innerHTML = '';

  const repeats = 15;
  for (let r = 0; r < repeats; r++) {
    for (let i = 0; i < WHEEL_ORDER.length; i++) {
      const n = WHEEL_ORDER[i];
      const el = document.createElement('div');
      el.className = `strip-num ${getColor(n)}`;
      el.textContent = n;
      el.dataset.number = n;
      strip.appendChild(el);
    }
  }

  // Wait one frame for elements to render, then measure and position
  requestAnimationFrame(() => {
    const itemW = getStripItemWidth();
    const idx = WHEEL_ORDER.indexOf(centerNumber);
    const centerIdx = Math.floor(repeats / 2) * WHEEL_ORDER.length + idx;
    const viewportWidth = $('.roulette-viewport').offsetWidth;
    const offset = centerIdx * itemW - viewportWidth / 2 + itemW / 2;
    strip.style.transform = `translateX(${-offset}px)`;
  });
}

function spinTo(targetNumber, fromNumber) {
  const strip = $('#rouletteStrip');

  // Rebuild strip positioned at fromNumber
  strip.classList.remove('spinning');
  strip.style.transition = 'none';
  strip.innerHTML = '';

  const repeats = 15;
  for (let r = 0; r < repeats; r++) {
    for (let i = 0; i < WHEEL_ORDER.length; i++) {
      const n = WHEEL_ORDER[i];
      const el = document.createElement('div');
      el.className = `strip-num ${getColor(n)}`;
      el.textContent = n;
      el.dataset.number = n;
      strip.appendChild(el);
    }
  }

  // Wait for render, then measure, position, and animate
  requestAnimationFrame(() => {
    const itemW = getStripItemWidth();
    const viewportWidth = $('.roulette-viewport').offsetWidth;

    const fromIdx = WHEEL_ORDER.indexOf(fromNumber);
    const toIdx = WHEEL_ORDER.indexOf(targetNumber);
    const halfRepeat = Math.floor(repeats / 2);

    // Position at fromNumber
    const startCenter = halfRepeat * WHEEL_ORDER.length + fromIdx;
    const startOffset = startCenter * itemW - viewportWidth / 2 + itemW / 2;
    strip.style.transform = `translateX(${-startOffset}px)`;

    // Force layout so the start position takes effect
    void strip.offsetHeight;

    // Calculate target: go 3 full rotations forward, then to target
    const extraRotations = 3 * WHEEL_ORDER.length;
    let targetCenter = startCenter + extraRotations;
    const remainder = targetCenter % WHEEL_ORDER.length;
    const diff = toIdx - remainder;
    targetCenter += diff >= 0 ? diff : diff + WHEEL_ORDER.length;

    const targetOffset = targetCenter * itemW - viewportWidth / 2 + itemW / 2;
    const jitter = (Math.random() - 0.5) * 10;

    // Now animate
    requestAnimationFrame(() => {
      strip.style.transition = 'transform 6s cubic-bezier(0.15, 0.85, 0.25, 1)';
      strip.classList.add('spinning');
      strip.style.transform = `translateX(${-(targetOffset + jitter)}px)`;
    });
  });

  setTimeout(() => {
    lastWinningNumber = targetNumber;
  }, 6200);
}

function highlightWinner(number) {
  $$('.table-cell').forEach(cell => {
    cell.classList.remove('winner-cell');
    if (cell.dataset.numbers) {
      const nums = JSON.parse(cell.dataset.numbers);
      if (nums.length === 1 && nums[0] === number) {
        cell.classList.add('winner-cell');
      }
    }
  });
  $$('.strip-num').forEach(el => el.classList.remove('winner'));
  $$(`.strip-num[data-number="${number}"]`).forEach(el => el.classList.add('winner'));
}

function clearWinnerHighlights() {
  $$('.table-cell').forEach(c => c.classList.remove('winner-cell'));
  $$('.strip-num').forEach(c => c.classList.remove('winner'));
}

// ── History ──────────────────────────────────────────────
function renderHistory(history) {
  const container = $('#historyNumbers');
  container.innerHTML = '';
  for (const h of history) {
    const el = document.createElement('div');
    el.className = `hist-num ${h.color}`;
    el.textContent = h.number;
    container.appendChild(el);
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
    if (socket && currentPhase === 'betting') {
      socket.emit('clearBets');
    }
  });
}

// ── Roulette Table ───────────────────────────────────────
function buildTable() {
  const table = $('#rouletteTable');
  table.innerHTML = '';

  // Zero cell
  const zero = createCell([0], '0', 'green-cell zero-cell');
  zero.style.gridRow = '1 / 4';
  zero.style.gridColumn = '1';
  table.appendChild(zero);

  // Number cells (3 rows x 12 cols)
  for (let col = 0; col < 12; col++) {
    for (let row = 0; row < 3; row++) {
      const num = tableNumber(row, col);
      const color = getColor(num);
      const cell = createCell([num], String(num), `${color === 'red' ? 'red' : 'black'}-cell`);
      cell.style.gridRow = String(row + 1);
      cell.style.gridColumn = String(col + 2);
      cell.dataset.row = row;
      cell.dataset.col = col;
      cell.addEventListener('click', (e) => handleNumberClick(e, cell, row, col, num));
      table.appendChild(cell);
    }
  }

  // Column bets (2:1)
  for (let row = 0; row < 3; row++) {
    const nums = [];
    for (let col = 0; col < 12; col++) nums.push(tableNumber(row, col));
    const cell = createCell(nums, '2:1', 'outside col-bet');
    cell.style.gridRow = String(row + 1);
    cell.style.gridColumn = '14';
    table.appendChild(cell);
  }

  // Dozen bets
  const dozenRanges = [[1,12],[13,24],[25,36]];
  const dozenLabels = ['1ª Doc', '2ª Doc', '3ª Doc'];
  for (let i = 0; i < 3; i++) {
    const nums = [];
    for (let n = dozenRanges[i][0]; n <= dozenRanges[i][1]; n++) nums.push(n);
    const cell = createCell(nums, dozenLabels[i], 'outside dozen-bet');
    cell.style.gridRow = '4';
    cell.style.gridColumn = `${i * 4 + 2} / ${i * 4 + 6}`;
    table.appendChild(cell);
  }

  // Bottom outside bets
  const outsideBets = [
    { label: '1-18', nums: Array.from({length:18}, (_,i) => i+1) },
    { label: 'PAR', nums: Array.from({length:18}, (_,i) => (i+1)*2) },
    { label: '◆', nums: [...RED_NUMBERS], cls: 'red-cell' },
    { label: '◆', nums: Array.from({length:36}, (_,i) => i+1).filter(n => !RED_NUMBERS.has(n)), cls: 'black-cell' },
    { label: 'IMPAR', nums: Array.from({length:18}, (_,i) => i*2+1) },
    { label: '19-36', nums: Array.from({length:18}, (_,i) => i+19) },
  ];

  for (let i = 0; i < outsideBets.length; i++) {
    const bet = outsideBets[i];
    const cell = createCell(bet.nums, bet.label, `outside outside-bottom ${bet.cls || ''}`);
    cell.style.gridRow = '5';
    const startCol = i * 2 + 2;
    cell.style.gridColumn = `${startCol} / ${startCol + 2}`;
    table.appendChild(cell);
  }

  // Empty fillers
  for (const r of ['4','5']) {
    for (const c of ['1','14']) {
      const empty = document.createElement('div');
      empty.style.gridRow = r;
      empty.style.gridColumn = c;
      table.appendChild(empty);
    }
  }
}

function createCell(numbers, label, extraClass) {
  const cell = document.createElement('div');
  cell.className = `table-cell ${extraClass || ''}`;
  cell.textContent = label;
  cell.dataset.numbers = JSON.stringify(numbers);
  cell.addEventListener('click', (e) => {
    // Only handle for outside bets and zero (cells without row data)
    if (!cell.dataset.row) {
      placeBet(numbers, cell);
    }
  });
  return cell;
}

function handleNumberClick(e, cell, row, col, num) {
  const rect = cell.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const w = rect.width;
  const h = rect.height;

  // Use 28% of cell dimensions as edge zone - works on any screen size
  const edgeX = w * 0.28;
  const edgeY = h * 0.28;

  const nearTop = y < edgeY && row > 0;
  const nearBottom = y > h - edgeY && row < 2;
  const nearLeft = x < edgeX && col > 0;
  const nearRight = x > w - edgeX && col < 11;

  // Corner bets (4 numbers)
  if (nearTop && nearLeft) {
    const nums = [num, tableNumber(row - 1, col), tableNumber(row, col - 1), tableNumber(row - 1, col - 1)].sort((a,b) => a-b);
    placeBet(nums, cell, 'corner');
    return;
  }
  if (nearTop && nearRight) {
    const nums = [num, tableNumber(row - 1, col), tableNumber(row, col + 1), tableNumber(row - 1, col + 1)].sort((a,b) => a-b);
    placeBet(nums, cell, 'corner');
    return;
  }
  if (nearBottom && nearLeft) {
    const nums = [num, tableNumber(row + 1, col), tableNumber(row, col - 1), tableNumber(row + 1, col - 1)].sort((a,b) => a-b);
    placeBet(nums, cell, 'corner');
    return;
  }
  if (nearBottom && nearRight) {
    const nums = [num, tableNumber(row + 1, col), tableNumber(row, col + 1), tableNumber(row + 1, col + 1)].sort((a,b) => a-b);
    placeBet(nums, cell, 'corner');
    return;
  }

  // Split bets (2 numbers)
  if (nearTop) {
    const nums = [num, tableNumber(row - 1, col)].sort((a,b) => a-b);
    placeBet(nums, cell, 'split-v');
    return;
  }
  if (nearBottom) {
    const nums = [num, tableNumber(row + 1, col)].sort((a,b) => a-b);
    placeBet(nums, cell, 'split-v');
    return;
  }
  if (nearLeft) {
    const nums = [num, tableNumber(row, col - 1)].sort((a,b) => a-b);
    placeBet(nums, cell, 'split-h');
    return;
  }
  if (nearRight) {
    const nums = [num, tableNumber(row, col + 1)].sort((a,b) => a-b);
    placeBet(nums, cell, 'split-h');
    return;
  }

  // Straight bet (center click)
  placeBet([num], cell, 'straight');
}

function placeBet(numbers, cell, betType) {
  if (currentPhase !== 'betting') {
    showToast('Espera a la ronda de apuestas');
    return;
  }
  if (!socket || !token) return;

  const amount = selectedChip;
  if (amount > balance) {
    showToast('Saldo insuficiente');
    return;
  }

  const betKey = numbers.sort((a,b) => a-b).join(',');
  socket.emit('placeBet', { betKey, numbers, amount });

  // Optimistic local update
  placedBets.push({ betKey, numbers, amount, chipValue: selectedChip });
  balance -= amount;
  updateBalanceDisplay();
  updateTotalBetDisplay();
  renderBetIndicator(cell, amount, betType);
}

function renderBetIndicator(cell, amount, betType) {
  const existing = cell.querySelector('.bet-indicator');
  if (existing) {
    const currentAmt = parseInt(existing.dataset.totalAmount || '0');
    const newAmt = currentAmt + amount;
    existing.dataset.totalAmount = newAmt;
    existing.textContent = newAmt >= 1000 ? Math.floor(newAmt/1000) + 'K' : newAmt;
    return;
  }

  const indicator = document.createElement('div');
  indicator.className = 'bet-indicator';
  indicator.style.background = CHIP_COLORS[selectedChip] || '#888';
  if (selectedChip === 1 || selectedChip === 1000) indicator.style.color = '#333';
  indicator.textContent = amount >= 1000 ? Math.floor(amount/1000) + 'K' : amount;
  indicator.dataset.totalAmount = amount;
  indicator.style.top = '50%';
  indicator.style.left = '50%';
  indicator.style.transform = 'translate(-50%, -50%)';

  cell.style.position = 'relative';
  cell.appendChild(indicator);
}

function clearLocalBets() {
  placedBets = [];
  updateTotalBetDisplay();
  $$('.bet-indicator').forEach(el => el.remove());
}

// ── Leaderboard ──────────────────────────────────────────
function initLeaderboard() {
  $('#leaderboardBtn').addEventListener('click', () => {
    $('#leaderboardModal').classList.remove('hidden');
    loadLeaderboard('alltime');
  });

  $('#closeLeaderboard').addEventListener('click', () => {
    $('#leaderboardModal').classList.add('hidden');
  });

  $('#leaderboardModal').addEventListener('click', (e) => {
    if (e.target === $('#leaderboardModal')) $('#leaderboardModal').classList.add('hidden');
  });

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

    if (data.length === 0) {
      body.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-dim)">Sin datos</div>';
      return;
    }

    data.forEach((row, i) => {
      const el = document.createElement('div');
      el.className = 'lb-row';
      const medals = ['👑', '🥈', '🥉'];
      const rankLabel = i < 3 ? medals[i] : `${i + 1}`;

      let valueHtml;
      if (type === 'alltime') {
        valueHtml = `<span class="lb-balance">${Math.floor(row.balance).toLocaleString('es-ES')}</span>`;
      } else {
        const profit = Math.floor(row.profit || 0);
        const cls = profit >= 0 ? 'positive' : 'negative';
        const sign = profit >= 0 ? '+' : '';
        valueHtml = `
          <span class="lb-balance">${Math.floor(row.balance).toLocaleString('es-ES')}</span>
          <span class="lb-profit ${cls}">${sign}${profit.toLocaleString('es-ES')}</span>
        `;
      }

      el.innerHTML = `
        <span class="lb-rank">${rankLabel}</span>
        <span class="lb-name">${escapeHtml(row.username)}</span>
        ${valueHtml}
      `;
      body.appendChild(el);
    });
  } catch (err) {
    body.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-dim)">Error al cargar</div>';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Init ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initAuth();
  initChips();
  buildTable();
  initLeaderboard();
  buildStrip(0);

  if (token) {
    tryAutoLogin();
  }
});
