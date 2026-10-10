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

const board = new Board(canvas);
let state = newGame();
let uiMode = 'move'; // move | target | resolving | gameover
let armedAttack = 'none';
let pending = { moveTo: null, attack: 'none', target: null };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function player() {
  return state.ships.find((s) => s.isPlayer);
}

function render() {
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
  board.moveOptions = p && p.alive ? validDestinations(p) : [];
}

function setAttackUI(atk) {
  armedAttack = atk;
  pending.attack = atk;
  atkButtons.forEach((b) => b.classList.toggle('active', b.dataset.atk === atk));
  if (atk === 'phasers' || atk === 'torpedoes') {
    uiMode = 'target';
    setHint(atk === 'phasers' ? 'Select phaser target hex' : 'Select torpedo target hex');
  } else {
    uiMode = 'move';
    board.targetHex = null;
    pending.target = null;
    setHint(pending.moveTo ? 'Ready — end your turn' : 'Select destination');
  }
  render();
}

function updateEndTurn() {
  endTurnBtn.disabled = !(pending.moveTo && uiMode !== 'resolving' && uiMode !== 'gameover');
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
    // move mode: accept only valid destinations
    if (board.moveOptions.some((h) => h.col === hex.col && h.row === hex.row)) {
      pending.moveTo = hex;
      board.selected = hex;
      setHint('Destination set — choose attack');
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

  // Action phase (750ms): everything happens at once, like the real turn.
  // - Ships glide to destinations.
  // - Phaser beams fire continuously, sweeping from each ship's live position.
  //   Hits flash with damage numbers the moment the beam crosses the victim.
  // - Torpedoes launched at turn start streak in, arriving as ships arrive.
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

  // Torpedo flights: from launch hex to victim destination (hit) or offscreen.
  const torpFlights = events.filter((x) => x.t === 'torp').map((e) => {
    const a = board.toScreen(e.from.col, e.from.row);
    let tx, ty;
    if (e.hit && e.victimId) {
      const v = newState.ships.find((s) => s.id === e.victimId);
      const vp = v ? board.toScreen(v.col, v.row) : board.toScreen(e.target.col, e.target.row);
      tx = vp.x; ty = vp.y;
    } else {
      const b = board.toScreen(e.target.col, e.target.row);
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      tx = b.x + (dx / len) * 500; ty = b.y + (dy / len) * 500;
    }
    board.addFx({ kind: 'torp', x1: a.x, y1: a.y, x2: tx, y2: ty, life: 720 });
    return { e, tx, ty, blasted: false };
  });

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
    if (k >= 0.9) {
      for (const t of torpFlights) {
        if (t.blasted) continue;
        t.blasted = true;
        if (t.e.hit) {
          board.addFx({ kind: 'blast', x: t.tx, y: t.ty, maxR: board.size * 1.1, life: 450 });
          const hitEv = events.find((x) => x.t === 'hit' && x.via === 'torpedoes' && x.id === t.e.victimId);
          board.addFx({
            kind: 'dmgnum', x: t.tx, y: t.ty - 12,
            text: '-' + (hitEv ? hitEv.dmg : ''), color: '#ff9e5e', life: 1100,
          });
        }
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
  if (torpFlights.some((t) => t.e.hit)) await frames(450, () => {});

  // Damage phase: at end positions — explosions for destroyed ships.
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
      ? { moveTo: pending.moveTo, attack: pending.attack, target: pending.target }
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
    pending = { moveTo: null, attack: 'none', target: null };
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

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  await loadSprites().catch((e) => console.warn('sprites failed', e));
  await ensureAuth(authStatus);
  onUser(async () => {
    const profile = (await loadProfile()) || loadProfileBackup();
    if (profile && profile.name) {
      const p = player();
      if (p) p.captain = profile.name;
    }
    render();
  });
  refreshMoveOptions();
  setHint('Select destination');
  updateEndTurn();
  render();
}

boot();
