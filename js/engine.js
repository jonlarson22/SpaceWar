// Turn engine: pure function, no UI. resolveTurn(state, orders) -> { state, events }.
// Seeded RNG (mulberry32) keeps resolution deterministic — same seed + same
// orders = same outcome, which is what future Firebase multiplayer needs.
import { hexDistance, hexToPixel, pixelToHex, inBounds, ROWS, COLS } from './hex.js';

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

  // Torpedo interception: the ray (from the firer's START hex through the
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

    if (atk === 'phasers' && target) {
      // Dwell-time model: the beam fires CONTINUOUSLY while ships move. For
      // each enemy, compute the fraction of the turn it spends inside the
      // beam (from the firer's live position to the target hex). Damage =
      // phaser power × dwell fraction. A stationary target at the aim point
      // takes full damage; a fast mover clipping the edge takes little.
      events.push({ t: 'beam', id: ship.id, to: { ...target } });
      const tgtPx = hexToPixel(target.col, target.row, 1);
      const f0 = hexToPixel(start.col, start.row, 1);
      const f1 = hexToPixel(ship.col, ship.row, 1); // firer end (already moved)
      for (const enemy of enemiesOf(ship)) {
        const est = starts[enemy.id];
        const e0 = hexToPixel(est.col, est.row, 1);
        const e1 = hexToPixel(enemy.col, enemy.row, 1);
        const STEPS = 12;
        let inside = 0;
        for (let i = 0; i <= STEPS; i++) {
          const f = i / STEPS;
          const fx = f0.x + (f1.x - f0.x) * f;
          const fy = f0.y + (f1.y - f0.y) * f;
          const ex = e0.x + (e1.x - e0.x) * f;
          const ey = e0.y + (e1.y - e0.y) * f;
          // Distance from enemy to beam segment (firer → target).
          const dx = tgtPx.x - fx, dy = tgtPx.y - fy;
          const l2 = dx * dx + dy * dy || 1;
          let t = ((ex - fx) * dx + (ey - fy) * dy) / l2;
          t = Math.max(0, Math.min(1, t));
          const px = fx + dx * t, py = fy + dy * t;
          if (Math.hypot(ex - px, ey - py) < 0.8) inside++;
        }
        const dwell = inside / (STEPS + 1);
        if (dwell > 0) {
          const dmg = Math.max(1, Math.round(ship.phasers * dwell));
          damage[enemy.id] = (damage[enemy.id] || 0) + dmg;
          // Hit position: where the enemy was mid-turn (use end hex for simplicity).
          events.push({ t: 'hit', id: enemy.id, dmg, via: 'phasers', by: ship.id, at: { col: enemy.col, row: enemy.row } });
        }
      }
    } else {
      // Torpedoes are PERSISTENT projectiles. Launched from the start hex,
      // they travel at constant speed along the ray through the target hex.
      // Each turn they move; if a torpedo enters a hex containing an enemy
      // ship, it hits for full damage. Otherwise it keeps flying until it
      // leaves the board. It's about timing, not prediction.
      const s = hexToPixel(start.col, start.row, 1);
      const t = hexToPixel(target.col, target.row, 1);
      const dx = t.x - s.x, dy = t.y - s.y;
      const len = Math.hypot(dx, dy);
      if (len >= 0.01) {
        const torp = {
          id: `torp-${state.turn}-${ship.id}`,
          x: s.x, y: s.y,
          dx: dx / len, dy: dy / len,
          ownerId: ship.id,
          ownerRace: ship.race,
          damage: ship.torpedoes,
        };
        state.torps.push(torp);
        events.push({ t: 'torp_launch', id: ship.id, from: { ...start }, torpId: torp.id });
      }
    }
  }

  // 2b. Move torpedoes and check collisions — SIMULTANEOUS. Both torps and
  // ships move over the turn; at each sub-step fraction f, if a torp and a
  // ship are in the same hex, the torp hits. Ships continue their paths
  // even after being hit (unless destroyed).
  const TORP_SPEED = 4.0;
  const torpsToRemove = new Set();
  // Precompute ship pixel paths for interpolation.
  const shipPaths = {};
  for (const ship of ships) {
    const st = starts[ship.id];
    const p0 = hexToPixel(st.col, st.row, 1);
    const p1 = hexToPixel(ship.col, ship.row, 1);
    shipPaths[ship.id] = { p0, p1 };
  }
  for (const torp of state.torps) {
    if (torpsToRemove.has(torp.id)) continue;
    const steps = Math.ceil(TORP_SPEED / 0.5);
    const x0 = torp.x, y0 = torp.y;
    let hitDone = false;
    for (let s = 1; s <= steps; s++) {
      const f = s / steps;
      const tx = x0 + torp.dx * TORP_SPEED * f;
      const ty = y0 + torp.dy * TORP_SPEED * f;
      const hex = pixelToHex(tx, ty, 1);
      if (!hex || !inBounds(hex.col, hex.row)) {
        torpsToRemove.add(torp.id);
        torp.x = tx; torp.y = ty;
        hitDone = true; // done (offscreen)
        break;
      }
      for (const ship of ships) {
        if (!ship.alive || ship.id === torp.ownerId) continue;
        if (state.teamPlay && ship.race === torp.ownerRace) continue;
        const path = shipPaths[ship.id];
        const sx = path.p0.x + (path.p1.x - path.p0.x) * f;
        const sy = path.p0.y + (path.p1.y - path.p0.y) * f;
        // Hit if torp and ship are close (paths cross mid-turn).
        if (Math.hypot(tx - sx, ty - sy) < 1.0) {
          const hex = pixelToHex(tx, ty, 1) || pixelToHex(sx, sy, 1);
          const at = hex && inBounds(hex.col, hex.row) ? { col: hex.col, row: hex.row } : { col: ship.col, row: ship.row };
          damage[ship.id] = (damage[ship.id] || 0) + torp.damage;
          events.push({ t: 'hit', id: ship.id, dmg: torp.damage, via: 'torpedoes', by: torp.ownerId, at });
          events.push({ t: 'torp_hit', torpId: torp.id, at });
          torpsToRemove.add(torp.id);
          torp.x = tx; torp.y = ty;
          hitDone = true;
          break;
        }
      }
      if (hitDone) break;
    }
    if (!hitDone) {
      torp.x = x0 + torp.dx * TORP_SPEED;
      torp.y = y0 + torp.dy * TORP_SPEED;
    }
  }
  state.torps = state.torps.filter((t) => !torpsToRemove.has(t.id));

  // 2c. Sentry guns: stationary, neutral. Each has a 33% chance per turn to
  // launch a torpedo at the NEAREST alive ship within 6 hexes.
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
    const s = hexToPixel(sentry.col, sentry.row, 1);
    const t = hexToPixel(targetShip.col, targetShip.row, 1);
    const dx = t.x - s.x, dy = t.y - s.y;
    const len = Math.hypot(dx, dy);
    if (len >= 0.01) {
      const torp = {
        id: `torp-${state.turn}-sentry-${sentry.id}`,
        x: s.x, y: s.y,
        dx: dx / len, dy: dy / len,
        ownerId: 'sentry-' + sentry.id,
        ownerRace: null, // hits everyone
        damage: 20,
      };
      state.torps.push(torp);
      events.push({ t: 'torp_launch', id: 'sentry-' + sentry.id, from: { col: sentry.col, row: sentry.row }, torpId: torp.id });
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
