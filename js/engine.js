// Turn engine: pure function, no UI. resolveTurn(state, orders) -> { state, events }.
// Seeded RNG (mulberry32) keeps resolution deterministic — same seed + same
// orders = same outcome, which is what future Firebase multiplayer needs.
import { hexDistance, hexLine, hexToPixel, inBounds, neighbors, ROWS, COLS } from './hex.js';

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
  // Start hexes are remembered: phasers sweep from where the ship was, and
  // torpedoes launch from the start hex.
  const starts = {};
  for (const ship of ships) {
    if (!ship.alive) continue;
    const o = orders[ship.id];
    const from = { col: ship.col, row: ship.row };
    starts[ship.id] = { col: from.col, row: from.row, speed: ship.speed };
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

  // Torpedo ray: straight path from the firer's START hex through the target
  // hex. Returns enemy ships (at END positions — where they are when the
  // torpedo arrives) near the ray, nearest first. A miss just keeps flying off.
  function torpedoVictims(ship, start, target) {
    const s = hexToPixel(start.col, start.row, 1);
    const t = hexToPixel(target.col, target.row, 1);
    const dx = t.x - s.x, dy = t.y - s.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.01) return [];
    const ux = dx / len, uy = dy / len;
    const found = [];
    for (const other of enemiesOf(ship)) {
      const p = hexToPixel(other.col, other.row, 1);
      const rx = p.x - s.x, ry = p.y - s.y;
      const along = rx * ux + ry * uy;
      if (along < 0.3) continue; // behind the firer
      const perp = Math.abs(rx * uy - ry * ux);
      if (perp < 0.8) found.push({ ship: other, along });
    }
    found.sort((a, b) => a.along - b.along);
    return found;
  }

  for (const ship of ships) {
    if (!ship.alive) continue;
    const o = orders[ship.id];
    const atk = o ? o.attack : 'none';
    const here = { col: ship.col, row: ship.row };      // end hex
    const start = starts[ship.id] || { ...here };        // start hex

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

    if (atk === 'phasers') {
      // The beam fires CONTINUOUSLY while the ship moves, sweeping from the
      // start hex to the target and from the end hex to the target. Ships in
      // hexes along the sweep take damage: full at the target hex, half
      // along the way (a grazing pass, not a sustained hit).
      events.push({ t: 'beam', id: ship.id, to: { ...target } });
      const swept = new Map();
      for (const h of [...hexLine(start, target), ...hexLine(here, target), ...neighbors(target.col, target.row)]) {
        swept.set(h.col + ',' + h.row, h);
      }
      const full = phaserDamage(ship, hexDistance(here, target));
      for (const h of swept.values()) {
        const isTarget = h.col === target.col && h.row === target.row;
        const hexDmg = isTarget ? full : Math.max(1, Math.round(full / 2));
        for (const v of enemiesOf(ship).filter((s) => s.col === h.col && s.row === h.row)) {
          damage[v.id] = (damage[v.id] || 0) + hexDmg;
          events.push({ t: 'hit', id: v.id, dmg: hexDmg, via: 'phasers', by: ship.id, at: { col: v.col, row: v.row } });
        }
      }
    } else {
      // Torpedoes launch IMMEDIATELY from the start hex along a straight ray.
      // First enemy ship on the ray (at its end position, where it is when
      // the torpedo arrives) takes the hit roll; a miss flies off.
      const victims = torpedoVictims(ship, start, target);
      const found = victims[0];
      if (found) {
        const victim = found.ship;
        const dist = hexDistance(start, victim);
        const p = torpedoHitChance(ship, dist, victim.speed);
        const hit = rng() < p;
        events.push({ t: 'torp', id: ship.id, from: { ...start }, target: { ...target }, hit, victimId: victim.id });
        if (hit) {
          damage[victim.id] = (damage[victim.id] || 0) + ship.torpedoes;
          events.push({ t: 'hit', id: victim.id, dmg: ship.torpedoes, via: 'torpedoes', by: ship.id, at: { col: victim.col, row: victim.row } });
        }
      } else {
        events.push({ t: 'torp', id: ship.id, from: { ...start }, target: { ...target }, hit: false, victimId: null });
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
