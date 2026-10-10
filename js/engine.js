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
// accelBonus: Tholian hyper-acceleration doubles the rate when not firing.
export function validDestinations(ship, accelBonus = 0) {
  const range = 2 + accelBonus;
  const minD = Math.max(0, ship.speed - range);
  const maxD = Math.min(ship.speed + range, ship.engine);
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
// target: hit chance falls off STEEPLY with range. Long shots are gambles.
export function torpedoHitChance(ship, dist, targetSpeed) {
  return Math.min(0.95, Math.max(0.05, 0.95 - 0.12 * dist - 0.05 * targetSpeed));
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
    const atk = o ? o.attack : 'none';
    let dest = { ...from };
    // Borg transwarp: instant move to any hex (then stopped).
    if (ship.race === 'borg' && atk === 'none' && o && o.special === 'transwarp' &&
        o.moveTo && inBounds(o.moveTo.col, o.moveTo.row)) {
      dest = { col: o.moveTo.col, row: o.moveTo.row };
      events.push({ t: 'transwarp', id: ship.id, from, to: { ...dest } });
    } else if (o && o.moveTo && inBounds(o.moveTo.col, o.moveTo.row)) {
      const d = hexDistance(from, o.moveTo);
      // Tholian hyper-acceleration: double rate when not firing.
      const range = (ship.race === 'tholian' && atk === 'none') ? 4 : 2;
      const minD = Math.max(0, ship.speed - range);
      const maxD = Math.min(ship.speed + range, ship.engine);
      if (d >= minD && d <= maxD) dest = { col: o.moveTo.col, row: o.moveTo.row };
    }
    if (dest.col !== from.col || dest.row !== from.row) {
      const isTranswarp = ship.race === 'borg' && atk === 'none' && o && o.special === 'transwarp';
      if (!isTranswarp) events.push({ t: 'move', id: ship.id, from, to: { ...dest } });
    }
    ship.col = dest.col;
    ship.row = dest.row;
    // Transwarp leaves the ship stopped; otherwise speed = distance.
    ship.speed = (ship.race === 'borg' && atk === 'none' && o && o.special === 'transwarp')
      ? 0 : hexDistance(from, dest);
    // Klingon cloak: active any turn the ship does not fire.
    if (ship.race === 'klingon') ship.cloaked = (atk === 'none');
    // Reset per-turn flags.
    ship.ablative = false;
  }

  // 1b. Non-firing specials (regen). Applied after movement, before damage.
  for (const ship of ships) {
    if (!ship.alive) continue;
    const o = orders[ship.id];
    const atk = o ? o.attack : 'none';
    if (atk !== 'none') continue;
    if (ship.race === 'borg' && o && o.special === 'regen') {
      ship.shields = Math.min(ship.maxShields, ship.shields + 5);
      events.push({ t: 'regen', id: ship.id, at: { col: ship.col, row: ship.row } });
    } else if (ship.race === 'dominion') {
      if (ship.shields < ship.maxShields) {
        ship.shields = Math.min(ship.maxShields, ship.shields + 5);
        events.push({ t: 'regen', id: ship.id, at: { col: ship.col, row: ship.row } });
      }
    } else if (ship.race === 'federation') {
      ship.ablative = true; // half damage this turn
    }
  }

  // 2. Attacks. All damage is computed first, then applied simultaneously,
  // so no ship gets an ordering advantage.
  const damage = {};
  const onSameTeam = (a, b) => state.teamPlay && a.race === b.race;
  const enemiesOf = (ship) => ships.filter((s) => s.alive && s.id !== ship.id && !onSameTeam(ship, s));

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
      // Deterministic: the FIRST enemy ship on the ray is hit for full damage.
      // There is no die roll — if you correctly predict where they'll be, you
      // hit. Dodging means not being on the ray. A clean miss flies off.
      const victims = torpedoVictims(ship, start, target);
      const found = victims[0];
      if (found) {
        const victim = found.ship;
        damage[victim.id] = (damage[victim.id] || 0) + ship.torpedoes;
        events.push({ t: 'torp', id: ship.id, from: { ...start }, target: { ...target }, hit: true, victimId: victim.id });
        events.push({ t: 'hit', id: victim.id, dmg: ship.torpedoes, via: 'torpedoes', by: ship.id, at: { col: victim.col, row: victim.row } });
      } else {
        events.push({ t: 'torp', id: ship.id, from: { ...start }, target: { ...target }, hit: false, victimId: null });
      }
    }
  }

  // 2b. Sentry guns: stationary, neutral. Each has a 33% chance per turn to
  // fire a torpedo at the NEAREST alive ship within 6 hexes (deterministic
  // ray — first ship on the path is hit). They're area hazards, not snipers.
  for (const sentry of (state.sentries || [])) {
    if (rng() >= 0.33) continue;
    const targets = ships.filter((s) => s.alive);
    if (!targets.length) break;
    let targetShip = null, bestD = 6;
    for (const t of targets) {
      const d = hexDistance(sentry, t);
      if (d <= bestD) { bestD = d; targetShip = t; }
    }
    if (!targetShip) continue;
    const from = { col: sentry.col, row: sentry.row };
    const target = { col: targetShip.col, row: targetShip.row };
    const s = hexToPixel(from.col, from.row, 1);
    const t = hexToPixel(target.col, target.row, 1);
    const dx = t.x - s.x, dy = t.y - s.y;
    const len = Math.hypot(dx, dy);
    let victimId = null, victim = null;
    if (len >= 0.01) {
      const ux = dx / len, uy = dy / len;
      let best = Infinity;
      for (const other of targets) {
        const p = hexToPixel(other.col, other.row, 1);
        const rx = p.x - s.x, ry = p.y - s.y;
        const along = rx * ux + ry * uy;
        if (along < 0.3) continue;
        if (Math.abs(rx * uy - ry * ux) < 0.8 && along < best) {
          best = along; victim = other; victimId = other.id;
        }
      }
    }
    events.push({ t: 'torp', id: 'sentry-' + sentry.id, from: { ...from }, target: { ...target }, hit: !!victim, victimId });
    if (victim) {
      damage[victim.id] = (damage[victim.id] || 0) + 20;
      events.push({ t: 'hit', id: victim.id, dmg: 20, via: 'torpedoes', by: 'sentry-' + sentry.id, at: { col: victim.col, row: victim.row } });
    }
  }

  // 3. Apply damage. Cloaked Klingons take double; ablative Federation halves.
  for (const ship of ships) {
    let dmg = damage[ship.id] || 0;
    if (dmg > 0) {
      if (ship.cloaked) dmg *= 2;
      if (ship.ablative) dmg = Math.ceil(dmg / 2);
      ship.shields -= dmg;
      if (ship.shields <= 0) {
        ship.shields = 0;
        ship.alive = false;
        events.push({ t: 'boom', id: ship.id, at: { col: ship.col, row: ship.row } });
      }
    }
  }

  // 4. Win / lose. In team play, races are teams; otherwise FFA.
  // The game ends when the player's team is eliminated (loss) or all
  // other teams/ships are eliminated (win).
  const playerTeamAlive = ships.some((s) => s.isPlayer && s.alive) ||
    (state.teamPlay && ships.some((s) => s.alive && s.race === ships.find((x) => x.isPlayer).race));
  const othersAlive = ships.some((s) => s.alive && !s.isPlayer &&
    !(state.teamPlay && s.race === ships.find((x) => x.isPlayer).race));
  let phase = 'orders';
  let winner = null;
  if (!playerTeamAlive || !othersAlive) {
    phase = 'gameover';
    winner = playerTeamAlive ? 'player' : 'enemy';
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
