import { config, type GuildId } from '../config.ts';
import { hexDistance, hexNeighbors, tileId } from './hex.ts';

export interface MapTile {
  id: string;
  q: number;
  r: number;
  owner: GuildId | null;
  isCity: boolean;
  /** How far the tile is developed. Missing in older callers means 0. */
  level?: number;
}

const CENTER = { q: 0, r: 0 };

/**
 * The neutral tile a guild raids in a War: one that touches its territory, as
 * near to its city as possible. Ties go to the tile nearest the map center,
 * then to the lowest tile id. Returns null when no neutral tile touches the
 * guild's territory.
 */
export function claimTarget(tiles: readonly MapTile[], guildId: GuildId): MapTile | null {
  const byId = new Map(tiles.map((tile) => [tile.id, tile]));
  const city = config.map.cities[guildId];

  const candidates = new Map<string, MapTile>();
  for (const tile of tiles) {
    if (tile.owner !== guildId) continue;
    for (const neighbor of hexNeighbors(tile)) {
      const other = byId.get(tileId(neighbor));
      if (other && other.owner === null) candidates.set(other.id, other);
    }
  }

  let best: MapTile | null = null;
  for (const tile of candidates.values()) {
    if (best === null || compare(tile, best, city) < 0) best = tile;
  }
  return best;
}

function compare(a: MapTile, b: MapTile, city: { q: number; r: number }): number {
  return (
    hexDistance(a, city) - hexDistance(b, city) ||
    hexDistance(a, CENTER) - hexDistance(b, CENTER) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
