// AI opponent. Stochastic by design: it picks randomly among good moves and
// varies its targeting, so it can't be mirrored into a deterministic dance
// and the player can't perfectly predict it either.
import { hexDistance } from './hex.js';
import { validDestinations, torpedoHitChance } from './engine.js';

export function aiOrders(state, ship, rng) {
  const enemies = state.ships.filter((s) => s.alive && s.id !== ship.id);
  const hold = {
    moveTo: { col: ship.col, row: ship.row },
    attack: 'none',
    target: null,
  };
  if (!enemies.length) return hold;

  let foe = enemies[0];
  let best = hexDistance(ship, foe);
  for (const e of enemies) {
    const d = hexDistance(ship, e);
    if (d < best) { best = d; foe = e; }
  }

  // Move: randomly pick among the destinations that close distance well.
  // The randomness breaks mirroring and keeps the AI unpredictable.
  const dests = validDestinations(ship);
  const scored = dests.map((d) => ({ d, s: hexDistance(d, foe) + rng() * 3 }));
  scored.sort((a, b) => a.s - b.s);
  const pool = scored.slice(0, Math.max(1, Math.min(4, scored.length)));
  const moveTo = pool[Math.floor(rng() * pool.length)].d;

  // Target: predict the foe's destination. Usually the foe keeps approaching,
  // so take its valid destination nearest to where WE will be. Mix in the
  // foe's current hex (it may hold still) to stay unpredictable.
  const foeDests = validDestinations(foe);
  let predicted = { col: foe.col, row: foe.row };
  let pd = hexDistance(predicted, moveTo);
  for (const d of foeDests) {
    const s = hexDistance(d, moveTo) + rng() * 1.5;
    if (s < pd) { pd = s; predicted = d; }
  }
  // If the foe is slow it's likely staying put — trust its current hex more.
  const target = (foe.speed <= 1 && rng() < 0.6)
    ? { col: foe.col, row: foe.row }
    : predicted;

  // Torpedoes fly a straight ray from our START hex through the target —
  // deadly up close, wild at range. Aim at the predicted destination (where
  // the foe will be when the torpedo arrives). Phasers sweep during movement.
  const launchDist = hexDistance({ col: ship.col, row: ship.row }, target);
  if (launchDist > 8) return { moveTo, attack: 'none', target: null };
  const p = torpedoHitChance(ship, launchDist, foe.speed);
  if (launchDist <= 4 && p > 0.25) {
    return { moveTo, attack: 'torpedoes', target };
  }
  return { moveTo, attack: 'phasers', target };
}
