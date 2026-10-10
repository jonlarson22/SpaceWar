// Canvas renderer: hex grid + ships. Pure drawing from state — no game logic.
import { ROWS, COLS, hexToPixel, hexCorners, pixelToHex, inBounds } from './hex.js';
import { spriteFor } from './sprites.js';

export class Board {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.size = 30;          // hex size (center to vertex), recomputed on resize
    this.originX = 0;        // pixel offset of grid origin
    this.originY = 0;
    this.selected = null;    // {col, row} highlighted hex
    this.moveOptions = [];   // valid destination hexes to highlight
    this.targetHex = null;   // attack target hex highlight
    this.shipScreenPos = {}; // shipId -> {x, y} override (for animations)
    this.fx = [];            // active effects: {kind, ...}
    this.resize();
  }

  resize() {
    const wrap = this.canvas.parentElement;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.floor(w * dpr));
    this.canvas.height = Math.max(1, Math.floor(h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w; this.h = h;
    this.fitGrid();
  }

  fitGrid() {
    // Fit the 14x11 grid into the view with padding.
    const pad = 24;
    const gridW = Math.sqrt(3) * (COLS + 0.5);
    const gridH = 1.5 * ROWS + 0.5;
    this.size = Math.min((this.w - pad * 2) / gridW, (this.h - pad * 2) / gridH);
    const totalW = this.size * gridW;
    const totalH = this.size * gridH;
    this.originX = (this.w - totalW) / 2;
    this.originY = (this.h - totalH) / 2;
  }

  toScreen(col, row) {
    // Shift so the grid's bounding box starts at (originX, originY).
    const p = hexToPixel(col, row, this.size);
    return {
      x: p.x + this.originX + (this.size * Math.sqrt(3)) / 2,
      y: p.y + this.originY + this.size,
    };
  }

  fromScreen(x, y) {
    const px = x - this.originX - (this.size * Math.sqrt(3)) / 2;
    const py = y - this.originY - this.size;
    return pixelToHex(px, py, this.size);
  }

  draw(state) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    // Starfield backdrop
    ctx.fillStyle = '#0a0e1a';
    ctx.fillRect(0, 0, this.w, this.h);
    this.drawStars(ctx);
    this.drawGrid(ctx);
    this.drawMoveOptions(ctx);
    if (state) this.drawShips(ctx, state);
    if (this.selected) this.drawSelection(ctx);
    if (this.targetHex) this.drawTarget(ctx);
    this.drawFx(ctx);
  }

  drawMoveOptions(ctx) {
    if (!this.moveOptions.length) return;
    for (const { col, row } of this.moveOptions) {
      const s = this.toScreen(col, row);
      const corners = hexCorners(s.x, s.y, this.size * 0.96);
      ctx.beginPath();
      corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = 'rgba(80, 200, 120, 0.18)';
      ctx.fill();
    }
  }

  drawTarget(ctx) {
    const { col, row } = this.targetHex;
    if (!inBounds(col, row)) return;
    const s = this.toScreen(col, row);
    const corners = hexCorners(s.x, s.y, this.size * 0.96);
    ctx.beginPath();
    corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(220, 60, 60, 0.3)';
    ctx.fill();
    ctx.strokeStyle = '#ff5e5e';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // --- animation support ---
  setShipScreenPos(id, x, y) { this.shipScreenPos[id] = { x, y }; }
  clearShipScreenPos() { this.shipScreenPos = {}; }
  addFx(fx) { this.fx.push({ born: performance.now(), ...fx }); }
  clearFx() { this.fx = []; }

  drawFx(ctx) {
    const now = performance.now();
    this.fx = this.fx.filter((f) => now - f.born < f.life);
    for (const f of this.fx) {
      const k = (now - f.born) / f.life; // 0..1
      if (f.kind === 'beam') {
        ctx.strokeStyle = `rgba(120, 220, 255, ${1 - k * 0.7})`;
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(f.x1, f.y1); ctx.lineTo(f.x2, f.y2); ctx.stroke();
        ctx.strokeStyle = `rgba(255, 255, 255, ${1 - k})`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(f.x1, f.y1); ctx.lineTo(f.x2, f.y2); ctx.stroke();
      } else if (f.kind === 'torp') {
        const x = f.x1 + (f.x2 - f.x1) * k;
        const y = f.y1 + (f.y2 - f.y1) * k;
        ctx.fillStyle = '#ffd75e';
        ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill();
        ctx.fillStyle = `rgba(255, 150, 50, ${0.5 * (1 - k)})`;
        ctx.beginPath(); ctx.arc(x, y, 8, 0, 7); ctx.fill();
      } else if (f.kind === 'blast') {
        const r = f.maxR * (0.3 + 0.7 * k);
        ctx.fillStyle = `rgba(255, ${Math.round(150 - 100 * k)}, 50, ${0.8 * (1 - k)})`;
        ctx.beginPath(); ctx.arc(f.x, f.y, r, 0, 7); ctx.fill();
        ctx.fillStyle = `rgba(255, 240, 200, ${0.9 * (1 - k)})`;
        ctx.beginPath(); ctx.arc(f.x, f.y, r * 0.5, 0, 7); ctx.fill();
      }
    }
  }

  drawStars(ctx) {
    // Deterministic pseudo-random stars so they don't shimmer on redraw.
    let seed = 1234567;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < 90; i++) {
      const x = rand() * this.w, y = rand() * this.h;
      const a = 0.15 + rand() * 0.5;
      ctx.globalAlpha = a;
      ctx.fillRect(x, y, rand() < 0.2 ? 2 : 1, rand() < 0.2 ? 2 : 1);
    }
    ctx.globalAlpha = 1;
  }

  drawGrid(ctx) {
    ctx.lineWidth = 1;
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const s = this.toScreen(col, row);
        const corners = hexCorners(s.x, s.y, this.size * 0.96);
        ctx.beginPath();
        corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.closePath();
        ctx.strokeStyle = 'rgba(90, 120, 180, 0.35)';
        ctx.stroke();
      }
    }
  }

  drawShips(ctx, state) {
    for (const ship of state.ships) {
      if (!ship.alive) continue;
      const override = this.shipScreenPos[ship.id];
      const s = override || this.toScreen(ship.col, ship.row);
      const img = spriteFor(ship.race);
      const dim = this.size * 1.5;
      if (img) {
        ctx.imageSmoothingEnabled = false; // keep pixel-art crisp
        ctx.drawImage(img, s.x - dim / 2, s.y - dim / 2, dim, dim);
      } else {
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, 7); ctx.fill();
      }
      if (ship.isPlayer) {
        ctx.strokeStyle = '#ffd75e';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(s.x, s.y, dim * 0.62, 0, 7); ctx.stroke();
      }
    }
  }

  drawSelection(ctx) {
    const { col, row } = this.selected;
    if (!inBounds(col, row)) return;
    const s = this.toScreen(col, row);
    const corners = hexCorners(s.x, s.y, this.size * 0.96);
    ctx.beginPath();
    corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 215, 94, 0.25)';
    ctx.fill();
    ctx.strokeStyle = '#ffd75e';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}
