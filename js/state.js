// Game state. Deliberately plain JSON — serializable from day one so a saved
// game or a Firebase multiplayer turn is just a document write.
// Turn resolution will be a pure function: resolveTurn(state, orders) -> state.
import { ROWS, COLS } from './hex.js';

export const RACE_STATS = {
  federation: { shields: 100, phasers: 55, torpedoes: 60, engine: 4 },
  klingon:    { shields: 90,  phasers: 60, torpedoes: 60, engine: 4 },
  borg:       { shields: 120, phasers: 50, torpedoes: 50, engine: 3 },
  dominion:   { shields: 100, phasers: 50, torpedoes: 60, engine: 4 },
  tholian:    { shields: 90,  phasers: 50, torpedoes: 60, engine: 5 },
};

let shipSeq = 0;

export function makeShip({ race, name, captain, col, row, isPlayer }) {
  const base = RACE_STATS[race];
  return {
    id: `ship-${++shipSeq}`,
    race, name, captain,
    col, row,
    speed: 2,
    shields: base.shields, maxShields: base.shields,
    phasers: base.phasers, torpedoes: base.torpedoes, engine: base.engine,
    cloaked: false,
    alive: true,
    isPlayer: !!isPlayer,
    // orders: { moveTo: {col,row}, attack: 'phasers'|'torpedoes'|'none'|'selfdestruct', target: {col,row}|null }
    orders: null,
  };
}

// Phase 0 demo game: player (Federation) vs one AI (Klingon).
export function newGame(playerName = 'Jameson') {
  return {
    version: 1,
    turn: 1,
    phase: 'orders', // orders -> resolved -> orders ... -> gameover
    winner: null,
    rngSeed: (Math.random() * 0xffffffff) >>> 0,
    ships: [
      makeShip({ race: 'federation', name: 'U.S.S. Reliant', captain: playerName, col: 2, row: 6, isPlayer: true }),
      makeShip({ race: 'klingon', name: 'I.K.S. Rotarran', captain: 'Azetbur', col: 8, row: 6, isPlayer: false }),
    ],
    log: [],
  };
}
