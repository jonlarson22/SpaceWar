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
    if (state) this.drawShips(ctx, state);
    if (this.selected) this.drawSelection(ctx);
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
      const s = this.toScreen(ship.col, ship.row);
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
