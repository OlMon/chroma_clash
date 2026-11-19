import { config, type GuildId, type SeasonStart } from '../config.ts';
import { hashString, type Rng } from '../util/rng.ts';
import { hexNeighbors, mapTiles, tileId, type Hex } from './hex.ts';

/** A tile's development: its level and the points collected toward the next. */
export interface Development {
  level: number;
  points: number;
}

/** Points needed to develop a tile from `level - 1` to `level`, at the given channel scale. */
export function levelCost(level: number, scale = 1): number {
  return Math.max(1, Math.round(config.land.costPerLevel * level * scale));
}

/**
 * The tile a guild develops next: its least developed one, so the land grows
 * evenly. Among equals, the one nearest its next level, then the lowest id.
 * Returns null when the guild has no tile left to develop.
 */
export function developTarget<T extends Development & { id: string }>(tiles: readonly T[]): T | null {
  let best: T | null = null;
  for (const tile of tiles) {
    if (tile.level >= config.land.maxLevel) continue;
    if (
      best === null ||
      tile.level < best.level ||
      (tile.level === best.level && (tile.points > best.points || (tile.points === best.points && tile.id < best.id)))
    ) {
      best = tile;
    }
  }
  return best;
}

/** Adds `amount` points (one chatter's tick, by default one) to a tile and returns its new development. */
export function addDevelopmentPoint(tile: Development, scale = 1, amount = 1): Development {
  let { level, points } = tile;
  if (level >= config.land.maxLevel) return { level, points: 0 };
  points += amount;
  while (level < config.land.maxLevel && points >= levelCost(level + 1, scale)) {
    points -= levelCost(level + 1, scale);
    level++;
  }
  return { level, points: level >= config.land.maxLevel ? 0 : points };
}

/** A stable number from 0 to 1 for a text. */
function hash01(text: string): number {
  return hashString(text) / 0x1_0000_0000;
}

/** How fertile a tile is in a season: the development points one tick gives it, on average. */
export function fertility(seasonId: number, tileIdValue: string): number {
  const { min, max } = config.land.fertility;
  return min + (max - min) * hash01(`fertility:${seasonId}:${tileIdValue}`);
}

/**
 * The points one tick gives a tile of this fertility: the whole part always,
 * one more with the chance of the rest. `roll` is a number from 0 to 1.
 */
export function tickPoints(tileFertility: number, roll: number): number {
  const whole = Math.floor(tileFertility);
  return whole + (roll < tileFertility - whole ? 1 : 0);
}

/**
 * A chatter's home tile among their guild's tiles that can still grow: the
 * one that scores highest for the chatter (rendezvous hashing), so it stays
 * the same while the guild keeps it, and only the chatters of a lost tile
 * move house. Null when no tile can grow.
 */
export function homeTile<T extends Development & { id: string }>(userId: string, tiles: readonly T[]): T | null {
  let best: T | null = null;
  let bestScore = -1;
  for (const tile of tiles) {
    if (tile.level >= config.land.maxLevel) continue;
    const score = hashString(`home:${userId}:${tile.id}`);
    if (score > bestScore || (score === bestScore && best !== null && tile.id < best.id)) {
      best = tile;
      bestScore = score;
    }
  }
  return best;
}

// --- Mishaps -----------------------------------------------------------------

/** A tile as mishaps see it. `burning` counts the windows a fire has burned on it; 0: no fire. */
export interface MishapTile {
  id: string;
  q: number;
  r: number;
  owner: GuildId | null;
  level: number;
  burning: number;
  /** False for cities and the center: mishaps leave them alone. */
  developable: boolean;
}

/**
 * What happened to a tile in a window:
 * - `lightning`: struck, `from` to `to`;
 * - `fire`: a fire started (and burned a first level), `spread` from a neighbour;
 * - `burn`: a fire burned on, `burntOut` and burned out by itself;
 * - `doused`: the owning guild put it out;
 * - `harvest`: a good harvest raised it a level.
 */
export interface Mishap {
  kind: 'lightning' | 'fire' | 'spread' | 'burn' | 'burntOut' | 'doused' | 'harvest';
  tile: string;
  owner: GuildId | null;
  from: number;
  to: number;
}

/** Picks one of `items` with chances in proportion to `weight`; null when all weigh nothing. */
function pickWeighted<T>(items: readonly T[], weight: (item: T) => number, rng: Rng): T | null {
  const total = items.reduce((sum, item) => sum + weight(item), 0);
  if (total <= 0) return null;
  let left = rng() * total;
  for (const item of items) {
    left -= weight(item);
    if (left < 0) return item;
  }
  return items[items.length - 1] ?? null;
}

/**
 * One window's mishaps. `activeBefore` counts each guild's members who were
 * active in the window before: enough of them put out a fire on their land.
 * Returns the tiles that changed (their new level and fire) and what happened,
 * in order. The tiles given are not changed.
 */
export function rollMishaps(
  tiles: readonly MishapTile[],
  activeBefore: Partial<Record<GuildId, number>>,
  rng: Rng,
): { changed: Map<string, { level: number; burning: number }>; events: Mishap[] } {
  const { lightning, fire, harvest } = config.mishaps;
  const state = new Map(tiles.map((t) => [t.id, { ...t }]));
  const changed = new Map<string, { level: number; burning: number }>();
  const events: Mishap[] = [];
  const set = (tile: MishapTile, level: number, burning: number) => {
    tile.level = level;
    tile.burning = burning;
    changed.set(tile.id, { level, burning });
  };
  const land = () => [...state.values()].filter((t) => t.developable);

  // Fires that are already burning: put out, burning on, spreading, or burnt out.
  const spreads: MishapTile[] = [];
  for (const tile of land().filter((t) => t.burning > 0)) {
    if (tile.owner && (activeBefore[tile.owner] ?? 0) >= fire.douse) {
      set(tile, tile.level, 0);
      events.push({ kind: 'doused', tile: tile.id, owner: tile.owner, from: tile.level, to: tile.level });
      continue;
    }
    const from = tile.level;
    const to = Math.max(0, from - 1);
    if (tile.burning + 1 >= fire.maxWindows || to === 0) {
      set(tile, to, 0);
      events.push({ kind: 'burntOut', tile: tile.id, owner: tile.owner, from, to });
    } else {
      set(tile, to, tile.burning + 1);
      events.push({ kind: 'burn', tile: tile.id, owner: tile.owner, from, to });
      if (rng() < fire.spreadChance) spreads.push(tile);
    }
  }
  for (const source of spreads) {
    const near = hexNeighbors(source)
      .map((hex) => state.get(tileId(hex)))
      .filter((t): t is MishapTile => Boolean(t && t.developable && t.burning === 0 && t.level > 0));
    const target = near.length > 0 ? near[Math.floor(rng() * near.length)]! : null;
    if (!target) continue;
    const from = target.level;
    set(target, from - 1, 1);
    events.push({ kind: 'spread', tile: target.id, owner: target.owner, from, to: from - 1 });
  }

  // A new fire, on a developed tile that is not burning yet; higher tiles catch fire more easily.
  if (rng() < fire.chance) {
    const target = pickWeighted(land().filter((t) => t.burning === 0 && t.level > 0), (t) => t.level, rng);
    if (target) {
      const from = target.level;
      set(target, from - 1, from - 1 > 0 ? 1 : 0);
      events.push({ kind: 'fire', tile: target.id, owner: target.owner, from, to: from - 1 });
    }
  }

  // Lightning seeks the tallest structures.
  if (rng() < lightning.chance) {
    const target = pickWeighted(land().filter((t) => t.level > 0), (t) => t.level * t.level, rng);
    if (target) {
      const from = target.level;
      const loss = lightning.levels + (rng() < lightning.extraChance ? 1 : 0);
      set(target, Math.max(0, from - loss), target.burning);
      events.push({ kind: 'lightning', tile: target.id, owner: target.owner, from, to: target.level });
    }
  }

  // Now and then a good harvest.
  if (rng() < harvest.chance) {
    const owned = land().filter((t) => t.owner !== null && t.level < config.land.maxLevel && t.burning === 0);
    const target = owned.length > 0 ? owned[Math.floor(rng() * owned.length)]! : null;
    if (target) {
      const from = target.level;
      set(target, from + 1, 0);
      events.push({ kind: 'harvest', tile: target.id, owner: target.owner, from, to: from + 1 });
    }
  }
  return { changed, events };
}

/** Whether a tile is the center: the god's tile, which is only ever held for a while. */
export function isCenter(tileIdValue: string): boolean {
  return tileIdValue === config.land.center.id;
}

/**
 * How much a guild's Monument grows in one window, from the tiles it holds
 * (their levels): every tile yields `perTile` and its level on top.
 */
export function monumentIncome(tileLevels: readonly number[]): number {
  const { baseIncome, perTile, perLevel } = config.monument;
  return baseIncome + tileLevels.reduce((sum, level) => sum + perTile + perLevel * level, 0);
}

/** The level a tile keeps when it is captured or scorched. */
export function levelAfterCapture(level: number): number {
  return Math.floor(level * config.land.keepOnCapture);
}

/** The defender's health bonus on a tile of this level, e.g. 0.12 for +12%. */
export function defenseBonus(level: number): number {
  return config.land.defensePerLevel * level;
}

/** Turns a tile a third of a circle around the center: Red's place becomes Blue's, Blue's Green's. */
function turn(hex: Hex): Hex {
  return { q: hex.r, r: -hex.q - hex.r };
}

/**
 * Who owns which tile when a season starts. Cities are not included; the
 * center tile is left out, so it starts neutral.
 * - `equal`: each guild gets the same five-tile sector next to its city.
 * - `random`: the same fifteen tiles are dealt at random, five to each guild.
 */
export function startingLand(mode: SeasonStart, rng: Rng): Record<string, GuildId> {
  // Red's sector turned once is Blue's, turned twice is Green's (see `config.map.cities`).
  const order: GuildId[] = ['red', 'blue', 'green'];
  const owners: Record<string, GuildId> = {};
  let sector: Hex[] = config.land.redSector;
  for (const guild of order) {
    for (const hex of sector) owners[tileId(hex)] = guild;
    sector = sector.map(turn);
  }
  if (mode === 'equal') return owners;

  const tiles = Object.keys(owners).sort();
  for (let i = tiles.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [tiles[i], tiles[j]] = [tiles[j]!, tiles[i]!];
  }
  const dealt: Record<string, GuildId> = {};
  tiles.forEach((id, index) => {
    dealt[id] = order[index % order.length]!;
  });
  return dealt;
}

/** Every tile of the map that is neither a city nor the center: the land that is dealt. */
export function dealtTiles(): string[] {
  const cities = new Set(Object.values(config.map.cities).map(tileId));
  return mapTiles()
    .filter((hex) => !(hex.q === 0 && hex.r === 0))
    .map(tileId)
    .filter((id) => !cities.has(id));
}
