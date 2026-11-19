import { config } from '../config.ts';

/** A hex tile in axial coordinates. */
export interface Hex {
  q: number;
  r: number;
}

const DIRECTIONS: readonly Hex[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export function tileId(hex: Hex): string {
  return `${hex.q},${hex.r}`;
}

/** Number of steps between two tiles. */
export function hexDistance(a: Hex, b: Hex): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

export function isOnMap(hex: Hex, radius = config.map.radius): boolean {
  return hexDistance(hex, { q: 0, r: 0 }) <= radius;
}

/** The neighbors of a tile that lie on the map. */
export function hexNeighbors(hex: Hex, radius = config.map.radius): Hex[] {
  return DIRECTIONS.map((d) => ({ q: hex.q + d.q, r: hex.r + d.r })).filter((n) =>
    isOnMap(n, radius),
  );
}

/** All tiles of the map, row by row. */
export function mapTiles(radius = config.map.radius): Hex[] {
  const tiles: Hex[] = [];
  for (let r = -radius; r <= radius; r++) {
    for (let q = -radius; q <= radius; q++) {
      if (isOnMap({ q, r }, radius)) tiles.push({ q, r });
    }
  }
  return tiles;
}
