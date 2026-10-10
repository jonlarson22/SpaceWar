// Hex math: pointy-top hexes, odd-r offset coordinates.
// Matches the original: 14 rows (1-14, top to bottom) x 11 cols (1-11, left to right).
// Internally 0-indexed; display converts to 1-indexed.
export const ROWS = 14;
export const COLS = 11;

export function inBounds(col, row) {
  return col >= 0 && col < COLS && row >= 0 && row < ROWS;
}

// Center pixel of hex (col, row) for a given hex size (center-to-vertex).
export function hexToPixel(col, row, size) {
  const x = size * Math.sqrt(3) * (col + 0.5 * (row & 1));
  const y = size * 1.5 * row;
  return { x, y };
}

// Six corner points of a pointy-top hex centered at (x, y).
export function hexCorners(x, y, size) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    pts.push({ x: x + size * Math.cos(angle), y: y + size * Math.sin(angle) });
  }
  return pts;
}

// Pixel -> {col, row} via cube rounding. Returns null when out of bounds.
export function pixelToHex(x, y, size) {
  const q = ((Math.sqrt(3) / 3) * x - (1 / 3) * y) / size;
  const r = ((2 / 3) * y) / size;
  const cube = axialRound(q, r);
  const row = cube.r;
  const col = cube.q + ((row - (row & 1)) / 2);
  const rc = Math.round(row), cc = Math.round(col);
  return inBounds(cc, rc) ? { col: cc, row: rc } : null;
}

function axialRound(q, r) {
  const x = q, z = r, y = -x - z;
  let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
  const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return { q: rx, r: rz };
}

// Neighbor offsets [dcol, drow] for odd-r.
const EVEN_OFFSETS = [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]];
const ODD_OFFSETS = [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]];

export function neighbors(col, row) {
  const offs = (row & 1) ? ODD_OFFSETS : EVEN_OFFSETS;
  const out = [];
  for (const [dc, dr] of offs) {
    const c = col + dc, r = row + dr;
    if (inBounds(c, r)) out.push({ col: c, row: r });
  }
  return out;
}

function toCube(col, row) {
  const x = col - ((row - (row & 1)) / 2);
  const z = row;
  return { x, z, y: -x - z };
}

export function hexDistance(a, b) {
  const A = toCube(a.col, a.row), B = toCube(b.col, b.row);
  return (Math.abs(A.x - B.x) + Math.abs(A.y - B.y) + Math.abs(A.z - B.z)) / 2;
}

// Display helpers: "C5" style labels like the original's row/col readouts.
export function hexLabel(col, row) {
  return `R${row + 1}C${col + 1}`;
}
