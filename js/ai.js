// AI opponent. Stochastic by design: it picks randomly among good moves and
// varies its targeting, so it can't be mirrored into a deterministic dance
// and the player can't perfectly predict it either.
import { hexDistance } from './hex.js';
import { validDestinations } from './engine.js';

export function aiOrders(state, ship, rng) {
  const teamPlay = !!state.teamPlay;
  // Enemies: not us, not teammates, and not cloaked (invisible).
  const enemies = state.ships.filter((s) =>
    s.alive && s.id !== ship.id &&
    !(teamPlay && s.race === ship.race) &&
    !s.cloaked
  );
  const hold = {
    moveTo: { col: ship.col, row: ship.row },
    attack: 'none',
    target: null,
    special: null,
  };
  if (!enemies.length) {
    // No visible enemies: use a beneficial special or hold.
    return aiSpecial(state, ship, rng, null, hold);
  }

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
  const target = (foe.speed <= 1 && rng() < 0.6)
    ? { col: foe.col, row: foe.row }
    : predicted;

  const launchDist = hexDistance({ col: ship.col, row: ship.row }, target);

  // Race specials: sometimes better than firing.
  const special = aiSpecial(state, ship, rng, foe, { moveTo, launchDist });
  if (special) return special;

  // Torpedoes: deterministic, first ship on the ray is hit. Best close.
  // Phasers sweep a field, better when unsure at range.
  if (launchDist > 8) return { moveTo, attack: 'none', target: null, special: null };
  if (launchDist <= 5) {
    return { moveTo, attack: 'torpedoes', target, special: null };
  }
  return { moveTo, attack: 'phasers', target, special: null };
}

// Returns special-ability orders, or null to fire normally.
function aiSpecial(state, ship, rng, foe, ctx) {
  const race = ship.race;
  const hurt = ship.shields < ship.maxShields * 0.6;
  const badlyHurt = ship.shields < ship.maxShields * 0.35;

  if (race === 'klingon') {
    // Cloak when badly hurt and not in a good firing position.
    if (badlyHurt && (!foe || ctx.launchDist > 4) && rng() < 0.7) {
      return { moveTo: ctx.moveTo, attack: 'none', target: null, special: null };
    }
    return null;
  }
  if (race === 'borg') {
    // Regen when hurt; transwarp when far from the action.
    if (hurt && rng() < 0.6) {
      return { moveTo: ctx.moveTo, attack: 'none', target: null, special: 'regen' };
    }
    if (foe && ctx.launchDist > 7 && rng() < 0.5) {
      // Transwarp to near the foe (stop 3 hexes out).
      const spots = [];
      for (let dc = -3; dc <= 3; dc++) {
        for (let dr = -3; dr <= 3; dr++) {
          const c = foe.col + dc, r = foe.row + dr;
          if (c >= 0 && c < 14 && r >= 0 && r < 11) spots.push({ col: c, row: r });
        }
      }
      const dest = spots[Math.floor(rng() * spots.length)];
      return { moveTo: dest, attack: 'none', target: null, special: 'transwarp' };
    }
    return null;
  }
  if (race === 'federation') {
    // Ablative: hold fire when badly hurt and the shot isn't great.
    if (badlyHurt && (!foe || ctx.launchDist > 5) && rng() < 0.5) {
      return { moveTo: ctx.moveTo, attack: 'none', target: null, special: null };
    }
    return null;
  }
  if (race === 'dominion') {
    // Regen when hurt and not in a good firing position.
    if (hurt && (!foe || ctx.launchDist > 5) && rng() < 0.6) {
      return { moveTo: ctx.moveTo, attack: 'none', target: null, special: null };
    }
    return null;
  }
  if (race === 'tholian') {
    // Hyper-accel is passive (moveTo already benefits if we don't fire).
    // Don't fire when we need a big reposition.
    if (foe && ctx.launchDist > 6 && rng() < 0.4) {
      const dests = validDestinations(ship, 2); // hyper-accel range
      const scored = dests.map((d) => ({ d, s: hexDistance(d, foe) + rng() * 2 }));
      scored.sort((a, b) => a.s - b.s);
      const moveTo = scored[0].d;
      return { moveTo, attack: 'none', target: null, special: null };
    }
    return null;
  }
  return null;
}
