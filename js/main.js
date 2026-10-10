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
  hexInfo.textContent = ship ? `${ship.name} — ${hexLabel(hex.col, hex.row)}` : hexLabel(hex.col, hex.row);

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

  // Phase 1: torpedoes launch IMMEDIATELY from start positions and fly a
  // straight ray through the target hex. A miss keeps flying off.
  for (const e of events.filter((x) => x.t === 'torp')) {
    const a = board.toScreen(e.from.col, e.from.row);
    const b = board.toScreen(e.target.col, e.target.row);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    // Fly past the target and off: extend well beyond.
    const far = { x: b.x + (dx / len) * 500, y: b.y + (dy / len) * 500 };
    let stop = far;
    let stopK = 1;
    if (e.hit && e.victimId) {
      const v = newState.ships.find((s) => s.id === e.victimId);
      if (v) {
        const vp = board.toScreen(v.col, v.row);
        // fraction along a->far where the victim sits
        const total = Math.hypot(far.x - a.x, far.y - a.y);
        const toV = Math.hypot(vp.x - a.x, vp.y - a.y);
        stopK = Math.min(1, toV / total);
        stop = vp;
      }
    }
    const flightMs = Math.round(650 * stopK);
    board.addFx({ kind: 'torp', x1: a.x, y1: a.y, x2: stop.x, y2: stop.y, life: flightMs });
    await frames(flightMs, () => {});
    if (e.hit) {
      board.addFx({ kind: 'blast', x: stop.x, y: stop.y, maxR: board.size * 1.1, life: 450 });
      await frames(450, () => {});
    }
  }

  // Phase 2: ships glide to destinations. Phasers fire CONTINUOUSLY during
  // the move — beams are drawn from each ship's interpolated position, so
  // they visibly sweep across hexes along the way.
  for (const e of events.filter((x) => x.t === 'beam')) {
    board.beamTargets[e.id] = e.to;
  }
  const moves = events.filter((e) => e.t === 'move');
  if (moves.length || Object.keys(board.beamTargets).length) {
    const pts = moves.map((m) => ({
      id: m.id,
      a: board.toScreen(m.from.col, m.from.row),
      b: board.toScreen(m.to.col, m.to.row),
    }));
    await frames(750, (k) => {
      const ez = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      for (const p of pts) {
        board.setShipScreenPos(p.id, p.a.x + (p.b.x - p.a.x) * ez, p.a.y + (p.b.y - p.a.y) * ez);
      }
    });
    board.clearShipScreenPos();
  }
  board.beamTargets = {};

  // Phase 3: now at end positions — phaser hit flashes, then explosions.
  // (This ordering fixes the old jump-back bug: weapons no longer fire
  // while ships are drawn at their start hexes.)
  state = newState;
  board.doomed = doomed;
  render();
  for (const e of events) {
    if (e.t === 'hit' && e.via === 'phasers') {
      const s = board.toScreen(e.at.col, e.at.row);
      board.addFx({ kind: 'blast', x: s.x, y: s.y, maxR: board.size * 0.9, life: 350 });
      await frames(350, () => {});
    } else if (e.t === 'boom' || e.t === 'selfdestruct') {
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
