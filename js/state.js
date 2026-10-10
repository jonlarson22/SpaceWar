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

const AI_NAMES = {
  federation: { ships: ['U.S.S. Enterprise', 'U.S.S. Voyager', 'U.S.S. Defiant'], captains: ['Picard', 'Janeway', 'Sisko'] },
  klingon:    { ships: ['I.K.S. Negh\'Var', 'I.K.S. Vor\'cha', 'I.K.S. Maht\'H'], captains: ['Martok', 'Gowron', 'Kang'] },
  borg:       { ships: ['Borg Cube 472', 'Borg Sphere 881', 'Borg Cube 119'], captains: ['Locutus', 'The Collective', 'Seven'] },
  dominion:   { ships: ['Jem\'Hadar Fighter', 'Dominion Battleship', 'Jem\'Hadar Cruiser'], captains: ['Weyoun', 'The Founders', 'Dukat'] },
  tholian:    { ships: ['Tholian Vessel', 'Tholian Cruiser', 'Tholian Destroyer'], captains: ['Assembly Prime', 'Loskene', 'Tholian High Command'] },
};

const START_SPOTS = [
  { col: 2, row: 5 }, { col: 11, row: 5 },
  { col: 2, row: 8 }, { col: 11, row: 8 },
];

// setup: { playerName, shipName, playerRace, aiRaces: ['klingon',...],
//          sentries: 0|1|2, teamPlay: bool }
export function newGame(setup = {}) {
  const {
    playerName = 'Jameson',
    shipName = 'U.S.S. Reliant',
    playerRace = 'federation',
    aiRaces = ['klingon'],
    sentries = 0,
    teamPlay = false,
  } = setup;
  const ships = [
    makeShip({ race: playerRace, name: shipName, captain: playerName, col: START_SPOTS[0].col, row: START_SPOTS[0].row, isPlayer: true }),
  ];
  const usedNames = new Set([shipName]);
  aiRaces.forEach((race, i) => {
    const pool = AI_NAMES[race] || AI_NAMES.klingon;
    const shipNameAi = pool.ships.find((n) => !usedNames.has(n)) || `${pool.ships[0]} ${i + 2}`;
    usedNames.add(shipNameAi);
    const spot = START_SPOTS[(i + 1) % START_SPOTS.length];
    ships.push(makeShip({
      race, name: shipNameAi,
      captain: pool.captains[i % pool.captains.length],
      col: spot.col, row: spot.row, isPlayer: false,
    }));
  });
  // Sentries at fixed midfield spots, kept clear of ships.
  const sentrySpots = [{ col: 6, row: 3 }, { col: 7, row: 9 }];
  const sentryList = [];
  for (let i = 0; i < sentries && i < sentrySpots.length; i++) {
    sentryList.push({ id: `sentry-${i + 1}`, col: sentrySpots[i].col, row: sentrySpots[i].row });
  }
  return {
    version: 2,
    turn: 1,
    phase: 'orders', // orders -> resolved -> orders ... -> gameover
    winner: null,
    teamPlay: !!teamPlay,
    rngSeed: (Math.random() * 0xffffffff) >>> 0,
    ships,
    sentries: sentryList,
    log: [],
  };
}
