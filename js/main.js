// Phase 1: full turn flow. Each turn: pick destination -> pick attack ->
// End Turn -> AI acts -> everything resolves simultaneously -> animate.
import { ensureAuth, onUser, loadProfile, loadProfileBackup } from './firebase.js';
import { loadSprites } from './sprites.js';
import { Board } from './board.js';
import { newGame } from './state.js';
import { resolveTurn, validDestinations, makeRng } from './engine.js';
import { aiOrders } from './ai.js';
import { hexLabel } from './hex.js';

const canvas = document.getElementById('board');
const hexInfo = document.getElementById('hex-info');
const authStatus = document.getElementById('auth-status');
const hudShields = document.getElementById('hud-shields');
const hudSpeed = document.getElementById('hud-speed');
const hint = document.getElementById('hint');
const endTurnBtn = document.getElementById('end-turn');
const atkButtons = [...document.querySelectorAll('.atk')];
const gameoverEl = document.getElementById('gameover');
const gameoverTitle = document.getElementById('gameover-title');
const gameoverSub = document.getElementById('gameover-sub');
const setupMenu = document.getElementById('setup-menu');

const RACE_INFO = {
  federation: { label: 'Federation', desc: 'Ablative armor: take half damage on turns you hold fire.' },
  klingon:    { label: 'Klingon', desc: 'Cloaking device: invisible when holding fire — but double damage if hit while cloaked.' },
  borg:       { label: 'Borg', desc: 'Transwarp or regen: when holding fire, teleport anywhere or restore 5 shields.' },
  dominion:   { label: 'Dominion', desc: 'Regenerative shields: restore 5 shields on turns you hold fire.' },
  tholian:    { label: 'Tholian', desc: 'Hyper-acceleration: double move rate on turns you hold fire.' },
};
const setup = {
  playerRace: 'federation',
  aiCount: 1,
  aiRaces: ['klingon'],
  sentries: 0,
  teamPlay: false,
};

const board = new Board(canvas);
let state = null; // created from setup menu
let uiMode = 'move'; // move | target | resolving | gameover
let armedAttack = 'none';
let pending = { moveTo: null, attack: 'none', target: null };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function player() {
  return state ? state.ships.find((s) => s.isPlayer) : null;
}

function render() {
  if (!state) return;
  board.draw(state);
  const p = player();
  if (p) {
    hudShields.textContent = `Shld: ${p.shields}`;
    hudSpeed.textContent = `Spd: ${p.speed}`;
  }
}

function setHint(t) { hint.textContent = t; }

function refreshMoveOptions() {
  const p = player();
  // Tholian hyper-accel: if holding fire, double the move rate.
  const bonus = (p && p.race === 'tholian' && pending.attack === 'none') ? 2 : 0;
  board.moveOptions = p && p.alive ? validDestinations(p, bonus) : [];
}

function setAttackUI(atk) {
  armedAttack = atk;
  pending.attack = atk;
  pending.special = null;
  atkButtons.forEach((b) => b.classList.toggle('active', b.dataset.atk === atk));
  const specRow = document.getElementById('special-row');
  const p = player();
  // Borg: holding fire offers Transwarp or Regen.
  if (atk === 'none' && p && p.race === 'borg') {
    specRow.classList.remove('hidden');
    setHint('Hold fire — Transwarp or Regen?');
  } else {
    specRow.classList.add('hidden');
  }
  // Tholian: holding fire unlocks hyper-accel — expand move options.
  if (p && p.race === 'tholian') refreshMoveOptions();
  if (atk === 'phasers' || atk === 'torpedoes') {
    uiMode = 'target';
    setHint(atk === 'phasers' ? 'Select phaser target hex' : 'Select torpedo target hex');
  } else if (atk === 'none' && p && p.race === 'borg') {
    uiMode = 'move'; // waiting for Transwarp/Regen pick
    board.targetHex = null;
    pending.target = null;
  } else {
    uiMode = 'move';
    board.targetHex = null;
    pending.target = null;
    const extra = (atk === 'none' && p && p.race === 'tholian') ? ' (hyper-accel active)' : '';
    setHint(pending.moveTo ? 'Ready — end your turn' + extra : 'Select destination' + extra);
  }
  render();
}

// Borg special picks.
document.getElementById('spec-transwarp').addEventListener('click', () => {
  pending.special = 'transwarp';
  document.getElementById('spec-transwarp').classList.add('active');
  document.getElementById('spec-regen').classList.remove('active');
  uiMode = 'move';
  setHint('Transwarp: tap ANY hex to teleport there');
  render();
});
document.getElementById('spec-regen').addEventListener('click', () => {
  pending.special = 'regen';
  document.getElementById('spec-regen').classList.add('active');
  document.getElementById('spec-transwarp').classList.remove('active');
  setHint('Regen +5 shields — end your turn');
  updateEndTurn();
  render();
});

function updateEndTurn() {
  const p = player();
  // Borg holding fire must pick Transwarp or Regen.
  const borgOk = !p || p.race !== 'borg' || pending.attack !== 'none' || !!pending.special;
  endTurnBtn.disabled = !(pending.moveTo && borgOk && uiMode !== 'resolving' && uiMode !== 'gameover');
}

function onTap(clientX, clientY) {
  if (uiMode === 'resolving' || uiMode === 'gameover') return;
  const rect = canvas.getBoundingClientRect();
  const hex = board.fromScreen(clientX - rect.left, clientY - rect.top);
  if (!hex) return;

  const ship = state.ships.find((s) => s.col === hex.col && s.row === hex.row && s.alive);
  if (ship) {
    // Like the original: tapping a ship shows its identity. Enemies also
    // show shield strength so you can see your damage land.
    hexInfo.textContent = ship.isPlayer
      ? `${ship.name} — ${hexLabel(hex.col, hex.row)}`
      : `${ship.name} — Shld ${ship.shields}`;
  } else {
    hexInfo.textContent = hexLabel(hex.col, hex.row);
  }

  if (uiMode === 'target') {
    pending.target = hex;
    board.targetHex = hex;
    board.selected = null;
    uiMode = 'move';
    setHint('Target locked — end your turn');
  } else {
    // move mode: Borg transwarp accepts ANY hex; otherwise valid destinations.
    const p = player();
    const isTranswarp = p && p.race === 'borg' && pending.attack === 'none' && pending.special === 'transwarp';
    const okHex = isTranswarp
      ? true // any in-bounds hex (fromScreen already bounds-checks)
      : board.moveOptions.some((h) => h.col === hex.col && h.row === hex.row);
    if (okHex) {
      pending.moveTo = hex;
      board.selected = hex;
      setHint(isTranswarp ? 'Transwarp locked — end your turn' : 'Destination set — choose attack');
    }
  }
  updateEndTurn();
  render();
}

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  onTap(e.clientX, e.clientY);
});

atkButtons.forEach((b) => b.addEventListener('click', () => setAttackUI(b.dataset.atk)));

// --- animation ---
function frames(ms, draw) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    (function frame(now) {
      const k = Math.min(1, (now - t0) / ms);
      draw(k);
      board.draw(state);
      if (k < 1) requestAnimationFrame(frame);
      else resolve();
    })(t0);
  });
}

async function animateEvents(result) {
  const newState = result.state;
  const events = result.events;
  const doomed = new Set(events.filter((e) => e.t === 'boom').map((e) => e.id));

  const ptSegDist = (px, py, x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1;
    const l2 = dx * dx + dy * dy || 1;
    let t = ((px - x1) * dx + (py - y1) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  };

  // Phase 0: specials. Transwarp snaps ships to destinations with a flash;
  // regen shows a green +5.
  let specialFlash = false;
  for (const e of events.filter((x) => x.t === 'transwarp')) {
    const s = board.toScreen(e.to.col, e.to.row);
    board.setShipScreenPos(e.id, s.x, s.y);
    board.addFx({ kind: 'blast', x: s.x, y: s.y, maxR: board.size, life: 400 });
    specialFlash = true;
  }
  for (const e of events.filter((x) => x.t === 'regen')) {
    const s = board.toScreen(e.at.col, e.at.row);
    board.addFx({ kind: 'dmgnum', x: s.x, y: s.y - 12, text: '+5', color: '#7dff8a', life: 900 });
    specialFlash = true;
  }
  if (specialFlash) await frames(450, () => {});

  // Phase 1: TORPEDOES fire immediately, each in turn. Constant flight speed
  // (px/sec) so long shots feel weighty. Hits explode with damage numbers;
  // a clean miss flies offscreen.
  const TORP_SPEED = 230; // px per second
  for (const e of events.filter((x) => x.t === 'torp')) {
    const a = board.toScreen(e.from.col, e.from.row);
    const b = board.toScreen(e.target.col, e.target.row);
    const dx = b.x - a.x, dy = b.y - a.y;
    const distPx = Math.hypot(dx, dy);
    if (distPx < 8) continue; // targeted own hex: fizzle, no torp
    let tx, ty, stopK = 1;
    if (e.hit && e.victimId) {
      const v = newState.ships.find((s) => s.id === e.victimId);
      const vp = v ? board.toScreen(v.col, v.row) : b;
      // stop at the victim (project onto ray)
      const len = distPx || 1;
      const t = ((vp.x - a.x) * dx + (vp.y - a.y) * dy) / (len * len);
      tx = a.x + dx * Math.max(0, t); ty = a.y + dy * Math.max(0, t);
      stopK = Math.min(1, Math.hypot(tx - a.x, ty - a.y) / distPx);
    } else {
      const len = distPx || 1;
      tx = b.x + (dx / len) * 420; ty = b.y + (dy / len) * 420;
    }
    const flightPx = Math.hypot(tx - a.x, ty - a.y);
    const flightMs = Math.max(300, Math.round((flightPx / TORP_SPEED) * 1000));
    board.addFx({ kind: 'torp', x1: a.x, y1: a.y, x2: tx, y2: ty, life: flightMs });
    await frames(flightMs, () => {});
    if (e.hit) {
      board.addFx({ kind: 'blast', x: tx, y: ty, maxR: board.size * 1.1, life: 450 });
      const hitEv = events.find((x) => x.t === 'hit' && x.via === 'torpedoes' && x.id === e.victimId);
      board.addFx({
        kind: 'dmgnum', x: tx, y: ty - 12,
        text: '-' + (hitEv ? hitEv.dmg : ''), color: '#ff9e5e', life: 1100,
      });
      await frames(450, () => {});
    }
    // else: clean miss — torp flies offscreen, no text needed.
  }

  // Phase 2: ships glide. Phaser beams fire continuously, sweeping from each
  // ship's live position; hits flash with damage numbers as the beam crosses.
  const beamFirers = new Map();
  for (const e of events.filter((x) => x.t === 'beam')) beamFirers.set(e.id, e.to);
  for (const [id, target] of beamFirers) board.beamTargets[id] = target;

  const moves = events.filter((e) => e.t === 'move');
  const movePts = moves.map((m) => ({
    id: m.id,
    a: board.toScreen(m.from.col, m.from.row),
    b: board.toScreen(m.to.col, m.to.row),
  }));
  const shipPos = new Map();
  for (const s of state.ships) {
    if (!s.alive) continue;
    const p = board.toScreen(s.col, s.row);
    shipPos.set(s.id, { x: p.x, y: p.y });
  }
  const pendingHits = events
    .filter((x) => x.t === 'hit' && x.via === 'phasers')
    .map((h) => ({ ...h, shown: false }));

  await frames(750, (k) => {
    const ez = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    for (const p of movePts) {
      const x = p.a.x + (p.b.x - p.a.x) * ez;
      const y = p.a.y + (p.b.y - p.a.y) * ez;
      board.setShipScreenPos(p.id, x, y);
      shipPos.set(p.id, { x, y });
    }
    for (const h of pendingHits) {
      if (h.shown) continue;
      const bt = board.beamTargets[h.by];
      const fp = shipPos.get(h.by);
      if (!bt || !fp) continue;
      const tp = board.toScreen(bt.col, bt.row);
      const vp = shipPos.get(h.id) || board.toScreen(h.at.col, h.at.row);
      if (ptSegDist(vp.x, vp.y, fp.x, fp.y, tp.x, tp.y) < board.size * 0.85) {
        h.shown = true;
        board.addFx({ kind: 'blast', x: vp.x, y: vp.y, maxR: board.size * 0.9, life: 350 });
        board.addFx({ kind: 'dmgnum', x: vp.x, y: vp.y - 12, text: '-' + h.dmg, color: '#ffd75e', life: 1000 });
      }
    }
  });
  board.clearShipScreenPos();
  board.beamTargets = {};
  for (const h of pendingHits) {
    if (h.shown) continue;
    h.shown = true;
    const s = board.toScreen(h.at.col, h.at.row);
    board.addFx({ kind: 'blast', x: s.x, y: s.y, maxR: board.size * 0.9, life: 350 });
    board.addFx({ kind: 'dmgnum', x: s.x, y: s.y - 12, text: '-' + h.dmg, color: '#ffd75e', life: 1000 });
  }
  if (pendingHits.length) await frames(400, () => {});

  // Phase 3: explosions for destroyed ships.
  state = newState;
  board.doomed = doomed;
  render();
  for (const e of events) {
    if (e.t === 'boom' || e.t === 'selfdestruct') {
      const s = board.toScreen(e.at.col, e.at.row);
      board.addFx({ kind: 'blast', x: s.x, y: s.y, maxR: board.size * 1.6, life: 650 });
      await frames(650, () => {});
      if (e.t === 'boom') board.doomed.delete(e.id);
      render();
    }
  }
  board.doomed.clear();
  board.clearFx();
}

async function endTurn() {
  if (!pending.moveTo || uiMode === 'resolving' || uiMode === 'gameover') return;
  uiMode = 'resolving';
  updateEndTurn();
  setHint('Resolving turn…');
  board.moveOptions = [];
  board.selected = null;
  render();

  const orders = {};
  for (const s of state.ships) {
    if (!s.alive) continue;
    orders[s.id] = s.isPlayer
      ? { moveTo: pending.moveTo, attack: pending.attack, target: pending.target, special: pending.special || null }
      : aiOrders(state, s, makeRng(state.rngSeed + s.id.length));
  }

  await wait(350); // let the player see their orders lock in
  const result = resolveTurn(state, orders);
  await animateEvents(result);

  if (state.phase === 'gameover') {
    uiMode = 'gameover';
    const won = state.winner === 'player';
    gameoverTitle.textContent = won ? 'Victory!' : 'Defeated';
    gameoverSub.textContent = won
      ? `Enemy destroyed on turn ${state.turn - 1}.`
      : `Your ship was destroyed on turn ${state.turn - 1}.`;
    gameoverEl.classList.remove('hidden');
    setHint('Game over');
  } else {
    pending = { moveTo: null, attack: 'none', target: null, special: null };
    board.targetHex = null;
    uiMode = 'move';
    setAttackUI('none');
    refreshMoveOptions();
    setHint('Select destination');
  }
  updateEndTurn();
  render();
}

endTurnBtn.addEventListener('click', endTurn);

document.getElementById('new-game').addEventListener('click', () => {
  gameoverEl.classList.add('hidden');
  state = newGame();
  pending = { moveTo: null, attack: 'none', target: null };
  board.targetHex = null;
  board.selected = null;
  uiMode = 'move';
  setAttackUI('none');
  refreshMoveOptions();
  setHint('Select destination');
  updateEndTurn();
  render();
});

window.addEventListener('resize', () => {
  board.resize();
  render();
});

// --- setup menu ---
function buildSetupMenu() {
  const racesEl = document.getElementById('setup-races');
  racesEl.innerHTML = '';
  for (const [key, info] of Object.entries(RACE_INFO)) {
    const b = document.createElement('button');
    b.textContent = info.label;
    b.classList.toggle('active', setup.playerRace === key);
    b.addEventListener('click', () => {
      setup.playerRace = key;
      [...racesEl.children].forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      document.getElementById('race-desc').textContent = info.desc;
      // Suggest a default ship name per race.
      const defaults = { federation: 'U.S.S. Reliant', klingon: 'I.K.S. Rotarran', borg: 'Borg Cube 101', dominion: 'Jem\'Hadar Fighter', tholian: 'Tholian Vessel' };
      document.getElementById('setup-shipname').value = defaults[key];
    });
    racesEl.appendChild(b);
  }
  document.getElementById('race-desc').textContent = RACE_INFO[setup.playerRace].desc;

  const sentEl = document.getElementById('setup-sentries');
  sentEl.innerHTML = '';
  [0, 1, 2].forEach((n) => {
    const b = document.createElement('button');
    b.textContent = String(n);
    b.classList.toggle('active', setup.sentries === n);
    b.addEventListener('click', () => {
      setup.sentries = n;
      [...sentEl.children].forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    });
    sentEl.appendChild(b);
  });

  const updateAi = () => {
    document.getElementById('ai-count').textContent = setup.aiCount;
    const wrap = document.getElementById('ai-races');
    wrap.innerHTML = '';
    setup.aiRaces = setup.aiRaces.slice(0, setup.aiCount);
    while (setup.aiRaces.length < setup.aiCount) setup.aiRaces.push('klingon');
    setup.aiRaces.forEach((race, i) => {
      const row = document.createElement('div');
      row.className = 'ai-race-row';
      const lab = document.createElement('span');
      lab.textContent = `AI ${i + 1}`;
      const sel = document.createElement('select');
      const opts = [['random', 'Random'], ...Object.entries(RACE_INFO).map(([k, v]) => [k, v.label])];
      for (const [val, label] of opts) {
        const o = document.createElement('option');
        o.value = val; o.textContent = label;
        if (race === val) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => { setup.aiRaces[i] = sel.value; });
      row.appendChild(lab); row.appendChild(sel);
      wrap.appendChild(row);
    });
  };
  document.getElementById('ai-minus').addEventListener('click', () => {
    setup.aiCount = Math.max(1, setup.aiCount - 1); updateAi();
  });
  document.getElementById('ai-plus').addEventListener('click', () => {
    setup.aiCount = Math.min(3, setup.aiCount + 1); updateAi();
  });
  updateAi();

  document.getElementById('setup-teamplay').addEventListener('change', (e) => {
    setup.teamPlay = e.target.checked;
  });

  document.getElementById('launch').addEventListener('click', () => {
    const aiRaces = setup.aiRaces.map((r) =>
      r === 'random' ? Object.keys(RACE_INFO)[Math.floor(Math.random() * 5)] : r);
    state = newGame({
      playerName: document.getElementById('setup-name').value || 'Jameson',
      shipName: document.getElementById('setup-shipname').value || 'Ship',
      playerRace: setup.playerRace,
      aiRaces,
      sentries: setup.sentries,
      teamPlay: setup.teamPlay,
    });
    setupMenu.classList.add('hidden');
    startTurn();
  });
}

function startTurn() {
  uiMode = 'move';
  armedAttack = 'none';
  pending = { moveTo: null, attack: 'none', target: null, special: null };
  board.clearFx();
  board.doomed.clear();
  refreshMoveOptions();
  setAttackUI('none');
  updateEndTurn();
  render();
}

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  await loadSprites().catch((e) => console.warn('sprites failed', e));
  await ensureAuth(authStatus);
  onUser(async () => {
    const profile = (await loadProfile()) || loadProfileBackup();
    if (profile && profile.name) {
      document.getElementById('setup-name').value = profile.name;
      const p = player();
      if (p) p.captain = profile.name;
    }
    render();
  });
  buildSetupMenu();
  setupMenu.classList.remove('hidden');
  // Draw an empty board behind the menu.
  board.draw({ ships: [], sentries: [] });
}

document.getElementById('new-game').addEventListener('click', () => {
  gameoverEl.classList.add('hidden');
  setupMenu.classList.remove('hidden');
  state = null;
  board.draw({ ships: [], sentries: [] });
});

boot();
