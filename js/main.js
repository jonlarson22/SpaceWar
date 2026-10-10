// Boot: PWA shell + Firebase auth + board. Phase 0 proves the stack:
// installable shell, hex grid rendering, tap input, sprites, Firebase identity.
import { ensureAuth, onUser, loadProfile, saveProfile, loadProfileBackup } from './firebase.js';
import { loadSprites } from './sprites.js';
import { Board } from './board.js';
import { newGame } from './state.js';
import { hexLabel } from './hex.js';

const canvas = document.getElementById('board');
const hexInfo = document.getElementById('hex-info');
const authStatus = document.getElementById('auth-status');
const hudShields = document.getElementById('hud-shields');
const hudSpeed = document.getElementById('hud-speed');

const board = new Board(canvas);
let state = newGame();

function render() {
  board.draw(state);
  const player = state.ships.find((s) => s.isPlayer);
  if (player) {
    hudShields.textContent = `Shld: ${player.shields}`;
    hudSpeed.textContent = `Spd: ${player.speed}`;
  }
}

function onTap(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const hex = board.fromScreen(clientX - rect.left, clientY - rect.top);
  if (hex) {
    board.selected = hex;
    const ship = state.ships.find((s) => s.col === hex.col && s.row === hex.row && s.alive);
    hexInfo.textContent = ship
      ? `${ship.name} — ${hexLabel(hex.col, hex.row)}`
      : hexLabel(hex.col, hex.row);
  } else {
    board.selected = null;
    hexInfo.textContent = '';
  }
  render();
}

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  onTap(e.clientX, e.clientY);
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

  // Firebase identity (anonymous, silent). Career profile loads from
  // Firestore; the localStorage copy is only a fallback.
  await ensureAuth(authStatus);
  onUser(async () => {
    let profile = await loadProfile();
    if (!profile) profile = loadProfileBackup();
    if (profile && profile.name) {
      const player = state.ships.find((s) => s.isPlayer);
      if (player) player.captain = profile.name;
    }
    render();
  });

  hexInfo.textContent = 'Tap a hex';
  render();
}

boot();
