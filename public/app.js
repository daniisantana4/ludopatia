const WHEEL_ORDER = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
const RED_NUMBERS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const CHIPS = [
  {value:1,label:'1'},{value:5,label:'5'},{value:25,label:'25'},{value:50,label:'50'},
  {value:100,label:'100'},{value:500,label:'500'},{value:1000,label:'1K'},{value:2500,label:'2.5K'}
];
const CHIP_COLORS = {1:'#e0e0e0',5:'#e53935',25:'#2e7d32',50:'#1565c0',100:'#212121',500:'#7b1fa2',1000:'#e8a500',2500:'#d81b60'};

function tableNumber(row, col) { return (col+1)*3 - row; }
function getColor(n) { return n===0?'green':RED_NUMBERS.has(n)?'red':'black'; }

let token = localStorage.getItem('casinoToken');
let socket = null, selectedChip = 5, balance = 0, currentPhase = 'waiting';
let placedBets = [], lastRoundBets = [], lastWinningNumber = 0;
// Map betKey -> {cell, chipColor} for visual indicators
const betCellMap = new Map();

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

function getStripItemWidth() {
  const item = $('.strip-num');
  if (!item) return 70;
  return item.offsetWidth + (parseFloat(getComputedStyle($('.roulette-strip')).gap) || 6);
}

// ── Auth ─────────────────────────────────────────────────
function initAuth() {
  $$('.auth-tab').forEach(t => t.addEventListener('click', () => {
    $$('.auth-tab').forEach(x => x.classList.remove('active')); t.classList.add('active');
    const isL = t.dataset.tab === 'login';
    $('#loginForm').classList.toggle('hidden', !isL);
    $('#registerForm').classList.toggle('hidden', isL);
    $('#authError').textContent = '';
  }));
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const r = await fetch('/api/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('#loginUser').value.trim(),password:$('#loginPass').value})});
      const d = await r.json(); if(!r.ok) throw new Error(d.error);
      token=d.token; localStorage.setItem('casinoToken',token); enterGame(d.username,d.balance);
    } catch(e) { $('#authError').textContent = e.message; }
  });
  $('#registerForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const r = await fetch('/api/register', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('#regUser').value.trim(),password:$('#regPass').value})});
      const d = await r.json(); if(!r.ok) throw new Error(d.error);
      token=d.token; localStorage.setItem('casinoToken',token); enterGame(d.username,d.balance);
    } catch(e) { $('#authError').textContent = e.message; }
  });
  $('#logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('casinoToken'); token=null;
    if(socket) socket.disconnect();
    $('#authModal').classList.remove('hidden'); $('#gameContainer').classList.add('hidden');
  });
}

function enterGame(username, bal) {
  $('#authModal').classList.add('hidden'); $('#gameContainer').classList.remove('hidden');
  $('#username').textContent = username; balance = bal; updateBalanceDisplay();
  connectSocket();
}

// ── Socket ───────────────────────────────────────────────
function connectSocket() {
  socket = io();
  socket.on('connect', () => { if(token) socket.emit('auth',token); });
  socket.on('authOk', d => { $('#username').textContent=d.username; balance=d.balance; updateBalanceDisplay(); });
  socket.on('authError', () => { localStorage.removeItem('casinoToken'); token=null; $('#authModal').classList.remove('hidden'); $('#gameContainer').classList.add('hidden'); });

  socket.on('gameState', d => {
    currentPhase=d.phase; lastWinningNumber=d.lastNumber||0;
    if(d.history) renderHistory(d.history);
    updatePhaseUI(d.phase,d.timer);
    buildStrip(lastWinningNumber);
  });

  socket.on('phase', d => {
    const prev = currentPhase; currentPhase = d.phase;
    if(d.history) renderHistory(d.history);

    if(d.phase === 'spinning') {
      hideRoundResults();
      spinTo(d.number, d.lastNumber||lastWinningNumber);
    } else if(d.phase === 'result') {
      if(d.number !== undefined) highlightWinner(d.number);
      if(d.roundWinners) showRoundResults(d.roundWinners, d.number);
    } else if(d.phase === 'betting' && prev === 'result') {
      if(placedBets.length > 0) lastRoundBets = [...placedBets];
      clearLocalBets(); clearWinnerHighlights();
      // Don't hide results until spinning starts
    }
    updatePhaseUI(d.phase, d.timer);
  });

  socket.on('betOk', d => { balance=d.balance; updateBalanceDisplay(); });
  socket.on('betError', msg => {
    if(placedBets.length>0) placedBets.pop();
    updateTotalBetDisplay();
    showToast(msg);
  });
  socket.on('balanceUpdate', d => { balance=d.balance; updateBalanceDisplay(); showPayout(d.payout,d.bet); });
  socket.on('betsCleared', d => { balance=d.balance; updateBalanceDisplay(); clearLocalBets(); });
}

function tryAutoLogin() {
  if(!token) return;
  $('#authModal').classList.add('hidden'); $('#gameContainer').classList.remove('hidden');
  connectSocket();
}

// ── UI ───────────────────────────────────────────────────
function updateBalanceDisplay() { $('#balance').textContent = Math.floor(balance).toLocaleString('es-ES'); }
function updatePhaseUI(phase, timer) {
  $('.phase-display').className = 'phase-display ' + phase;
  const t=$('#phaseText'), tm=$('#phaseTimer');
  if(phase==='betting'){t.textContent='¡Hagan sus apuestas!';tm.textContent=timer||'';}
  else if(phase==='spinning'){t.textContent='Girando...';tm.textContent='';}
  else if(phase==='result'){t.textContent='Resultado';tm.textContent=timer||'';}
  else{t.textContent='Esperando jugadores...';tm.textContent='';}
}
function getTotalBet() { return placedBets.reduce((s,b)=>s+b.amount,0); }
function updateTotalBetDisplay() { $('#totalBetDisplay').textContent = getTotalBet().toLocaleString('es-ES'); }

function showPayout(payout, bet) {
  const n=$('#payoutNotif'), t=$('#payoutText');
  if(bet===0){n.classList.add('hidden');return;}
  if(payout>0){n.className='payout-notif win';t.textContent=`+${Math.floor(payout).toLocaleString('es-ES')} fichas`;}
  else{n.className='payout-notif lose';t.textContent=`-${Math.floor(bet).toLocaleString('es-ES')} fichas`;}
  n.classList.remove('hidden');
  setTimeout(()=>n.classList.add('hidden'),3500);
}
function showToast(msg) {
  const n=$('#payoutNotif'),t=$('#payoutText');
  n.className='payout-notif lose';t.textContent=msg;n.classList.remove('hidden');
  setTimeout(()=>n.classList.add('hidden'),2000);
}

// ── Round Results ────────────────────────────────────────
function showRoundResults(winners, number) {
  const container = $('#roundResults');
  const body = $('#roundWinnersBody');
  body.innerHTML = '';

  if (winners.length === 0) {
    body.innerHTML = '<div class="round-no-winners">Nadie ha ganado esta ronda</div>';
  } else {
    for (const w of winners) {
      const row = document.createElement('div');
      row.className = 'round-winner-row';
      row.innerHTML = `
        <span class="round-winner-name">${escapeHtml(w.username)}</span>
        <span class="round-winner-profit">+${Math.floor(w.profit).toLocaleString('es-ES')}</span>
      `;
      body.appendChild(row);
    }
  }
  container.classList.remove('hidden');
}
function hideRoundResults() { $('#roundResults').classList.add('hidden'); }

// ── Strip ────────────────────────────────────────────────
function buildStrip(centerNumber) {
  const strip = $('#rouletteStrip');
  strip.style.transition = 'none'; strip.innerHTML = '';
  const repeats = 15;
  for(let r=0;r<repeats;r++) for(const n of WHEEL_ORDER) {
    const el = document.createElement('div');
    el.className = `strip-num ${getColor(n)}`; el.textContent = n; el.dataset.number = n;
    strip.appendChild(el);
  }
  requestAnimationFrame(() => {
    const iw = getStripItemWidth(), idx = WHEEL_ORDER.indexOf(centerNumber);
    const c = Math.floor(repeats/2)*WHEEL_ORDER.length + idx;
    const vw = $('.roulette-viewport').offsetWidth;
    strip.style.transform = `translateX(${-(c*iw - vw/2 + iw/2)}px)`;
  });
}

function spinTo(target, from) {
  const strip = $('#rouletteStrip');
  strip.style.transition = 'none'; strip.innerHTML = '';
  const repeats = 15;
  for(let r=0;r<repeats;r++) for(const n of WHEEL_ORDER) {
    const el = document.createElement('div');
    el.className = `strip-num ${getColor(n)}`; el.textContent = n; el.dataset.number = n;
    strip.appendChild(el);
  }
  requestAnimationFrame(() => {
    const iw = getStripItemWidth(), vw = $('.roulette-viewport').offsetWidth;
    const fi = WHEEL_ORDER.indexOf(from), ti = WHEEL_ORDER.indexOf(target);
    const half = Math.floor(repeats/2);
    const sc = half*WHEEL_ORDER.length + fi;
    strip.style.transform = `translateX(${-(sc*iw - vw/2 + iw/2)}px)`;
    void strip.offsetHeight;
    const extra = 3*WHEEL_ORDER.length;
    let tc = sc + extra;
    const rem = tc % WHEEL_ORDER.length;
    const diff = ti - rem;
    tc += diff>=0 ? diff : diff+WHEEL_ORDER.length;
    const jitter = (Math.random()-0.5)*10;
    requestAnimationFrame(() => {
      strip.style.transition = 'transform 6s cubic-bezier(0.15,0.85,0.25,1)';
      strip.style.transform = `translateX(${-(tc*iw - vw/2 + iw/2 + jitter)}px)`;
    });
  });
  setTimeout(() => { lastWinningNumber = target; }, 6200);
}

function highlightWinner(num) {
  $$('.table-cell').forEach(c => {
    c.classList.remove('winner-cell');
    if(c.dataset.numbers) { const ns=JSON.parse(c.dataset.numbers); if(ns.length===1&&ns[0]===num) c.classList.add('winner-cell'); }
  });
  $$(`.strip-num[data-number="${num}"]`).forEach(e => e.classList.add('winner'));
}
function clearWinnerHighlights() { $$('.table-cell').forEach(c=>c.classList.remove('winner-cell')); $$('.strip-num').forEach(c=>c.classList.remove('winner')); }

function renderHistory(history) {
  const c=$('#historyNumbers'); c.innerHTML='';
  for(const h of history){const e=document.createElement('div');e.className=`hist-num ${h.color}`;e.textContent=h.number;c.appendChild(e);}
}

// ── Chips ────────────────────────────────────────────────
function initChips() {
  const list = $('#chipList');
  for(const chip of CHIPS) {
    const el = document.createElement('div');
    el.className = 'chip'+(chip.value===selectedChip?' selected':'');
    el.dataset.value = chip.value; el.textContent = chip.label;
    el.addEventListener('click', () => { $$('.chip').forEach(c=>c.classList.remove('selected')); el.classList.add('selected'); selectedChip=chip.value; });
    list.appendChild(el);
  }
  $('#clearBetsBtn').addEventListener('click', () => { if(socket&&currentPhase==='betting') socket.emit('clearBets'); });
  $('#repeatBetBtn').addEventListener('click', repeatLastBet);
}

function repeatLastBet() {
  if(currentPhase!=='betting'){showToast('Espera a la ronda de apuestas');return;}
  if(!socket||!token)return;
  if(lastRoundBets.length===0){showToast('No hay apuesta anterior');return;}
  const needed = lastRoundBets.reduce((s,b)=>s+b.amount,0);
  if(needed>balance){showToast('Saldo insuficiente para repetir');return;}
  for(const bet of lastRoundBets) {
    socket.emit('placeBet',{betKey:bet.betKey,numbers:bet.numbers,amount:bet.amount});
    placedBets.push({...bet});
    balance -= bet.amount; updateBalanceDisplay(); updateTotalBetDisplay();
    // Find cell to show indicator
    const cell = findCellForNumbers(bet.numbers);
    if(cell) renderBetIndicator(cell, bet.amount, bet.chipValue, bet.indicatorPos);
  }
}

function findCellForNumbers(numbers) {
  // For single number bets, find the exact cell
  if(numbers.length === 1) {
    const cells = $$('.table-cell[data-numbers]');
    const key = JSON.stringify(numbers);
    for(const c of cells) { if(c.dataset.numbers === key) return c; }
  }
  // For splits/corners/outside, find any cell containing the first number
  const cells = $$('.table-cell[data-row]');
  for(const c of cells) {
    const ns = JSON.parse(c.dataset.numbers);
    if(ns[0] === numbers[0]) return c;
  }
  // Outside bets
  const all = $$('.table-cell[data-numbers]');
  const key = JSON.stringify([...numbers].sort((a,b)=>a-b));
  for(const c of all) { if(c.dataset.numbers === key) return c; }
  return null;
}

// ── Table ────────────────────────────────────────────────
function buildTable() {
  const table = $('#rouletteTable');
  table.innerHTML = '';

  // Zero
  const zero = mkCell([0], '0', 'green-cell zero-cell');
  zero.style.gridRow='1/4'; zero.style.gridColumn='1';
  zero.addEventListener('click', () => placeBet([0], zero, 'center'));
  table.appendChild(zero);

  // Numbers
  for(let col=0;col<12;col++) for(let row=0;row<3;row++) {
    const num = tableNumber(row,col);
    const cell = mkCell([num], String(num), `${getColor(num)==='red'?'red':'black'}-cell`);
    cell.style.gridRow=String(row+1); cell.style.gridColumn=String(col+2);
    cell.dataset.row=row; cell.dataset.col=col;
    cell.addEventListener('click', e => handleNumberClick(e,cell,row,col,num));
    table.appendChild(cell);
  }

  // Column 2:1
  for(let row=0;row<3;row++){
    const ns=[]; for(let c=0;c<12;c++) ns.push(tableNumber(row,c));
    const cell=mkCell(ns,'2:1','outside col-bet');
    cell.style.gridRow=String(row+1); cell.style.gridColumn='14';
    cell.addEventListener('click',()=>placeBet(ns,cell,'center'));
    table.appendChild(cell);
  }

  // Dozens
  [[1,12,'1ª Doc'],[13,24,'2ª Doc'],[25,36,'3ª Doc']].forEach(([a,b,l],i)=>{
    const ns=[]; for(let n=a;n<=b;n++) ns.push(n);
    const cell=mkCell(ns,l,'outside dozen-bet');
    cell.style.gridRow='4'; cell.style.gridColumn=`${i*4+2}/${i*4+6}`;
    cell.addEventListener('click',()=>placeBet(ns,cell,'center'));
    table.appendChild(cell);
  });

  // Bottom outside
  const outs=[
    {l:'1-18',ns:Array.from({length:18},(_,i)=>i+1)},
    {l:'PAR',ns:Array.from({length:18},(_,i)=>(i+1)*2)},
    {l:'◆',ns:[...RED_NUMBERS],cls:'red-cell'},
    {l:'◆',ns:Array.from({length:36},(_,i)=>i+1).filter(n=>!RED_NUMBERS.has(n)),cls:'black-cell'},
    {l:'IMPAR',ns:Array.from({length:18},(_,i)=>i*2+1)},
    {l:'19-36',ns:Array.from({length:18},(_,i)=>i+19)}
  ];
  outs.forEach((b,i)=>{
    const cell=mkCell(b.ns,b.l,`outside outside-bottom ${b.cls||''}`);
    cell.style.gridRow='5'; cell.style.gridColumn=`${i*2+2}/${i*2+4}`;
    cell.addEventListener('click',()=>placeBet(b.ns,cell,'center'));
    table.appendChild(cell);
  });

  // Fillers
  for(const r of ['4','5']) for(const c of ['1','14']){
    const e=document.createElement('div'); e.style.gridRow=r; e.style.gridColumn=c; table.appendChild(e);
  }
}

function mkCell(numbers, label, cls) {
  const cell = document.createElement('div');
  cell.className = `table-cell ${cls||''}`;
  cell.textContent = label;
  cell.dataset.numbers = JSON.stringify(numbers);
  return cell;
}

function handleNumberClick(e, cell, row, col, num) {
  const rect = cell.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const w = rect.width, h = rect.height;

  // 30% edge zones
  const ex = w * 0.30, ey = h * 0.30;

  const top = y < ey && row > 0;
  const bot = y > h-ey && row < 2;
  const left = x < ex && col > 0;
  const right = x > w-ex && col < 11;

  // Corner (4 numbers)
  if(top && left) {
    const ns=[num,tableNumber(row-1,col),tableNumber(row,col-1),tableNumber(row-1,col-1)].sort((a,b)=>a-b);
    return placeBet(ns,cell,'top-left');
  }
  if(top && right) {
    const ns=[num,tableNumber(row-1,col),tableNumber(row,col+1),tableNumber(row-1,col+1)].sort((a,b)=>a-b);
    return placeBet(ns,cell,'top-right');
  }
  if(bot && left) {
    const ns=[num,tableNumber(row+1,col),tableNumber(row,col-1),tableNumber(row+1,col-1)].sort((a,b)=>a-b);
    return placeBet(ns,cell,'bottom-left');
  }
  if(bot && right) {
    const ns=[num,tableNumber(row+1,col),tableNumber(row,col+1),tableNumber(row+1,col+1)].sort((a,b)=>a-b);
    return placeBet(ns,cell,'bottom-right');
  }

  // Split (2 numbers)
  if(top) { const ns=[num,tableNumber(row-1,col)].sort((a,b)=>a-b); return placeBet(ns,cell,'top'); }
  if(bot) { const ns=[num,tableNumber(row+1,col)].sort((a,b)=>a-b); return placeBet(ns,cell,'bottom'); }
  if(left) { const ns=[num,tableNumber(row,col-1)].sort((a,b)=>a-b); return placeBet(ns,cell,'left'); }
  if(right) { const ns=[num,tableNumber(row,col+1)].sort((a,b)=>a-b); return placeBet(ns,cell,'right'); }

  // Straight (center)
  placeBet([num], cell, 'center');
}

function placeBet(numbers, cell, indicatorPos) {
  if(currentPhase!=='betting'){showToast('Espera a la ronda de apuestas');return;}
  if(!socket||!token)return;
  const amount = selectedChip;
  if(amount>balance){showToast('Saldo insuficiente');return;}

  const betKey = [...numbers].sort((a,b)=>a-b).join(',');
  socket.emit('placeBet',{betKey,numbers:[...numbers],amount});
  placedBets.push({betKey,numbers:[...numbers],amount,chipValue:selectedChip,indicatorPos});
  balance -= amount; updateBalanceDisplay(); updateTotalBetDisplay();
  renderBetIndicator(cell, amount, selectedChip, indicatorPos);
}

function renderBetIndicator(cell, amount, chipVal, pos) {
  // Position the chip indicator based on where the bet was placed
  let top='50%', left='50%';
  if(pos==='top') { top='0%'; left='50%'; }
  else if(pos==='bottom') { top='100%'; left='50%'; }
  else if(pos==='left') { top='50%'; left='0%'; }
  else if(pos==='right') { top='50%'; left='100%'; }
  else if(pos==='top-left') { top='0%'; left='0%'; }
  else if(pos==='top-right') { top='0%'; left='100%'; }
  else if(pos==='bottom-left') { top='100%'; left='0%'; }
  else if(pos==='bottom-right') { top='100%'; left='100%'; }

  const posKey = `${cell.dataset.row||'x'},${cell.dataset.col||'x'},${pos}`;

  // Check if there's already an indicator at this exact position
  const existing = cell.querySelector(`.bet-indicator[data-pos-key="${posKey}"]`);
  if(existing) {
    const cur = parseInt(existing.dataset.totalAmount||'0');
    const nw = cur + amount;
    existing.dataset.totalAmount = nw;
    existing.textContent = nw>=1000 ? Math.floor(nw/1000)+'K' : nw;
    return;
  }

  const ind = document.createElement('div');
  ind.className = 'bet-indicator';
  ind.dataset.posKey = posKey;
  ind.style.background = CHIP_COLORS[chipVal]||'#888';
  if(chipVal===1||chipVal===1000) ind.style.color='#333';
  ind.textContent = amount>=1000 ? Math.floor(amount/1000)+'K' : amount;
  ind.dataset.totalAmount = amount;
  ind.style.top = top; ind.style.left = left;
  ind.style.transform = 'translate(-50%,-50%)';
  ind.style.position = 'absolute';
  cell.appendChild(ind);
}

function clearLocalBets() {
  placedBets = []; betCellMap.clear();
  updateTotalBetDisplay();
  $$('.bet-indicator').forEach(el=>el.remove());
}

// ── Leaderboard ──────────────────────────────────────────
function initLeaderboard() {
  $('#leaderboardBtn').addEventListener('click',()=>{$('#leaderboardModal').classList.remove('hidden');loadLeaderboard('alltime');});
  $('#closeLeaderboard').addEventListener('click',()=>$('#leaderboardModal').classList.add('hidden'));
  $('#leaderboardModal').addEventListener('click',e=>{if(e.target===$('#leaderboardModal'))$('#leaderboardModal').classList.add('hidden');});
  $$('.lb-tab').forEach(t=>t.addEventListener('click',()=>{
    $$('.lb-tab').forEach(x=>x.classList.remove('active'));t.classList.add('active');loadLeaderboard(t.dataset.lb);
  }));
}

async function loadLeaderboard(type) {
  const body=$('#leaderboardBody');
  body.innerHTML='<div style="text-align:center;padding:2rem;color:var(--text-dim)">Cargando...</div>';
  try {
    const r=await fetch(`/api/leaderboard/${type}`); const data=await r.json(); body.innerHTML='';
    if(!data.length){body.innerHTML='<div style="text-align:center;padding:2rem;color:var(--text-dim)">Sin datos</div>';return;}
    data.forEach((row,i)=>{
      const el=document.createElement('div');el.className='lb-row';
      const medals=['👑','🥈','🥉'];const rank=i<3?medals[i]:`${i+1}`;
      let val;
      if(type==='alltime'){val=`<span class="lb-balance">${Math.floor(row.balance).toLocaleString('es-ES')}</span>`;}
      else{const p=Math.floor(row.profit||0);val=`<span class="lb-balance">${Math.floor(row.balance).toLocaleString('es-ES')}</span><span class="lb-profit ${p>=0?'positive':'negative'}">${p>=0?'+':''}${p.toLocaleString('es-ES')}</span>`;}
      el.innerHTML=`<span class="lb-rank">${rank}</span><span class="lb-name">${escapeHtml(row.username)}</span>${val}`;
      body.appendChild(el);
    });
  } catch{body.innerHTML='<div style="text-align:center;padding:2rem;color:var(--text-dim)">Error</div>';}
}

function escapeHtml(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}

// ── Init ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initAuth(); initChips(); buildTable(); initLeaderboard(); buildStrip(0);
  if(token) tryAutoLogin();
});
