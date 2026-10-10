// Sprite loading: upscaled, race-tinted PNGs extracted from the original PRC.
const RACES = ['federation', 'klingon', 'borg', 'dominion', 'tholian'];
const cache = {};

export function loadSprites() {
  const jobs = RACES.map((race) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { cache[race] = img; resolve(); };
    img.onerror = reject;
    img.src = `assets/sprites/${race}.png`;
  }));
  return Promise.all(jobs);
}

export function spriteFor(race) {
  return cache[race] || null;
}

export function races() {
  return RACES.slice();
}
