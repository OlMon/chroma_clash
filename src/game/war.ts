import { config, type GuildId } from '../config.ts';
import type { Rng } from '../util/rng.ts';
import { claimTarget, type MapTile } from './expansion.ts';
import { hexDistance, hexNeighbors, tileId } from './hex.ts';

export type WarTarget =
  | { kind: 'attack'; tile: MapTile; defender: GuildId }
  | { kind: 'skirmish'; tile: MapTile };

/** Tiles each guild owns besides its city. */
export function tileCounts(tiles: readonly MapTile[]): Record<GuildId, number> {
  const counts = { red: 0, green: 0, blue: 0 };
  for (const tile of tiles) if (tile.owner && !tile.isCity) counts[tile.owner]++;
  return counts;
}

/**
 * The order in which guilds attack in a War: fewest tiles first, so the
 * weakest guild moves before the map changes. Ties are broken by the seed.
 */
export function battleOrder(tiles: readonly MapTile[], rng: Rng): GuildId[] {
  const counts = tileCounts(tiles);
  return config.guilds.list
    .map((guild) => ({ id: guild.id, tiles: counts[guild.id], tieBreak: rng() }))
    .sort((a, b) => a.tiles - b.tiles || a.tieBreak - b.tieBreak)
    .map((entry) => entry.id);
}

/**
 * What a guild attacks in its battle.
 * 1. If its territory touches enemy tiles (cities cannot be taken), it attacks
 *    the neighbor that owns the most tiles, on a random tile it touches.
 * 2. Otherwise it raids the neutral tile it would claim next: a skirmish.
 * 3. Otherwise there is nothing in reach and the result is null.
 */
export function chooseTarget(tiles: readonly MapTile[], attacker: GuildId, rng: Rng): WarTarget | null {
  const byId = new Map(tiles.map((tile) => [tile.id, tile]));
  const touched = new Map<GuildId, Map<string, MapTile>>();
  for (const tile of tiles) {
    if (tile.owner !== attacker) continue;
    for (const neighbor of hexNeighbors(tile)) {
      const other = byId.get(tileId(neighbor));
      if (!other || other.isCity || other.owner === null || other.owner === attacker) continue;
      if (!touched.has(other.owner)) touched.set(other.owner, new Map());
      touched.get(other.owner)!.set(other.id, other);
    }
  }

  if (touched.size > 0) {
    const counts = tileCounts(tiles);
    const neighbors = config.guilds.list
      .filter((guild) => touched.has(guild.id))
      .map((guild) => ({ id: guild.id, tiles: counts[guild.id], tieBreak: rng() }))
      .sort((a, b) => b.tiles - a.tiles || a.tieBreak - b.tieBreak);
    const defender = neighbors[0]!.id;
    const options = [...touched.get(defender)!.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    return { kind: 'attack', defender, tile: options[Math.floor(rng() * options.length)]! };
  }

  const neutral = claimTarget(tiles, attacker);
  return neutral ? { kind: 'skirmish', tile: neutral } : null;
}

/** The guild that owns the most tiles, or null if nobody owns one. Ties are broken by the seed. */
export function leadingGuild(tiles: readonly MapTile[], rng: Rng): GuildId | null {
  const counts = tileCounts(tiles);
  const most = Math.max(...config.guilds.list.map((guild) => counts[guild.id]));
  if (most === 0) return null;
  const leaders = config.guilds.list.filter((guild) => counts[guild.id] === most);
  return leaders[Math.floor(rng() * leaders.length)]!.id;
}

/** A guild's tile farthest from its city, or null if it owns none. Ties are broken by the seed. */
export function farthestTile(tiles: readonly MapTile[], guildId: GuildId, rng: Rng): MapTile | null {
  const city = config.map.cities[guildId];
  const own = tiles.filter((tile) => tile.owner === guildId && !tile.isCity);
  if (own.length === 0) return null;
  const farthest = Math.max(...own.map((tile) => hexDistance(tile, city)));
  const options = own
    .filter((tile) => hexDistance(tile, city) === farthest)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return options[Math.floor(rng() * options.length)]!;
}
