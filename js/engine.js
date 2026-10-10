// Turn engine: pure function, no UI. resolveTurn(state, orders) -> { state, events }.
// Seeded RNG (mulberry32) keeps resolution deterministic — same seed + same
// orders = same outcome, which is what future Firebase multiplayer needs.
import { hexDistance, inBounds, neighbors, ROWS, COLS } from './hex.js';

export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Hexes this ship may move to: distance within [speed-2, speed+2], capped by engine.
// New speed becomes the distance traveled ("the distance of your destination
// from your present location determines your final speed").
export function validDestinations(ship) {
  const minD = Math.max(0, ship.speed - 2);
  const maxD = Math.min(ship.speed + 2, ship.engine);
  const from = { col: ship.col, row: ship.row };
  const out = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const d = hexDistance(from, { col: c, row: r });
      if (d >= minD && d <= maxD) out.push({ col: c, row: r });
    }
  }
  return out;
}

// Phasers sweep while the firing ship moves: stationary = sustained full hit,
// faster = wider sweep = less dwell time on target. Damage also falls off
// with range.
export function phaserDamage(ship, dist) {
  const sweep = 1 / (1 + 0.25 * ship.speed);
  const range = Math.max(0.2, 1 - 0.09 * dist);
  return Math.max(1, Math.round(ship.phasers * sweep * range));
}

// Torpedoes always do full damage on a hit, but they're slow and hard to
// target: hit chance falls off steeply with range and target speed.
export function torpedoHitChance(ship, dist, targetSpeed) {
  return Math.min(0.95, Math.max(0.05, 0.95 - 0.09 * dist - 0.05 * targetSpeed));
}

export function resolveTurn(state, orders) {
  const rng = makeRng(state.rngSeed >>> 0);
  const events = [];
  const ships = state.ships.map((s) => ({ ...s }));

  // 1. Movement (validated; illegal orders fall back to holding position).
  for (const ship of ships) {
    if (!ship.alive) continue;
    const o = orders[ship.id];
    const from = { col: ship.col, row: ship.row };
    let dest = { ...from };
    if (o && o.moveTo && inBounds(o.moveTo.col, o.moveTo.row)) {
      const d = hexDistance(from, o.moveTo);
      const minD = Math.max(0, ship.speed - 2);
      const maxD = Math.min(ship.speed + 2, ship.engine);
      if (d >= minD && d <= maxD) dest = { col: o.moveTo.col, row: o.moveTo.row };
    }
    if (dest.col !== from.col || dest.row !== from.row) {
      events.push({ t: 'move', id: ship.id, from, to: { ...dest } });
    }
    ship.col = dest.col;
    ship.row = dest.row;
    ship.speed = hexDistance(from, dest);
  }

  // 2. Attacks. All damage is computed first, then applied simultaneously,
  // so no ship gets an ordering advantage.
  const damage = {};
  const enemiesOf = (ship) => ships.filter((s) => s.alive && s.id !== ship.id);

  for (const ship of ships) {
    if (!ship.alive) continue;
    const o = orders[ship.id];
    const atk = o ? o.attack : 'none';
    const here = { col: ship.col, row: ship.row };

    if (atk === 'selfdestruct') {
      events.push({ t: 'selfdestruct', id: ship.id, at: { ...here } });
      damage[ship.id] = (damage[ship.id] || 0) + 99999;
      for (const other of enemiesOf(ship)) {
        if (hexDistance(here, other) <= 2) {
          damage[other.id] = (damage[other.id] || 0) + 120;
        }
      }
      continue;
    }
    if (atk !== 'phasers' && atk !== 'torpedoes') continue;
    const target = o && o.target;
    if (!target || !inBounds(target.col, target.row)) continue;
    const dist = hexDistance(here, target);
    const victims = enemiesOf(ship).filter((s) => s.col === target.col && s.row === target.row);

    if (atk === 'phasers') {
      // Phasers sweep a FIELD, not a single hex: the target hex plus its
      // neighbors. Center takes full damage, the fringe takes half.
      // (Manual: "your present speed and position in relation to the target
      // hex determine the size of the field of your phaser fire.")
      events.push({ t: 'beam', id: ship.id, from: { ...here }, to: { ...target } });
      const field = [target, ...neighbors(target.col, target.row)];
      const dmg = phaserDamage(ship, dist);
      for (const hex of field) {
        const isCenter = hex.col === target.col && hex.row === target.row;
        const hexDmg = isCenter ? dmg : Math.max(1, Math.round(dmg / 2));
        for (const v of enemiesOf(ship).filter((s) => s.col === hex.col && s.row === hex.row)) {
          damage[v.id] = (damage[v.id] || 0) + hexDmg;
          events.push({ t: 'hit', id: v.id, dmg: hexDmg, via: 'phasers', at: { col: v.col, row: v.row } });
        }
      }
    } else {
      for (const v of victims) {
        const p = torpedoHitChance(ship, dist, v.speed);
        const hit = rng() < p;
        events.push({ t: 'torp', id: ship.id, from: { ...here }, to: { ...target }, hit });
        if (hit) {
          damage[v.id] = (damage[v.id] || 0) + ship.torpedoes;
          events.push({ t: 'hit', id: v.id, dmg: ship.torpedoes, via: 'torpedoes', at: { col: v.col, row: v.row } });
        }
      }
      if (victims.length === 0) {
        events.push({ t: 'torp', id: ship.id, from: { ...here }, to: { ...target }, hit: false });
      }
    }
  }

  // 3. Apply damage.
  for (const ship of ships) {
    const dmg = damage[ship.id] || 0;
    if (dmg > 0) {
      ship.shields -= dmg;
      if (ship.shields <= 0) {
        ship.shields = 0;
        ship.alive = false;
        events.push({ t: 'boom', id: ship.id, at: { col: ship.col, row: ship.row } });
      }
    }
  }

  // 4. Win / lose.
  const playerAlive = ships.some((s) => s.isPlayer && s.alive);
  const enemyAlive = ships.some((s) => !s.isPlayer && s.alive);
  let phase = 'orders';
  let winner = null;
  if (!playerAlive || !enemyAlive) {
    phase = 'gameover';
    winner = playerAlive ? 'player' : 'enemy';
  }

  return {
    state: {
      ...state,
      ships,
      turn: state.turn + 1,
      phase,
      winner,
      rngSeed: ((state.rngSeed >>> 0) + 1) >>> 0,
    },
    events,
  };
}
