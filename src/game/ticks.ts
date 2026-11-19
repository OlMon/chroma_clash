import { config } from '../config.ts';

/** Start of the activity window that contains `time` (ms since the Unix epoch). */
export function windowStartOf(time: number): number {
  const { windowMs } = config.ticks;
  return Math.floor(time / windowMs) * windowMs;
}

/** XP for one tick. `ownedTiles` counts the guild's tiles besides its city. */
export function tickXp(ownedTiles: number, boosted: boolean): number {
  const { xpPerTick, xpPerOwnedTile, maxOwnedTileXp, boostMultiplier } = config.ticks;
  const tileXp = Math.min(maxOwnedTileXp, Math.max(0, ownedTiles) * xpPerOwnedTile);
  const xp = xpPerTick + tileXp;
  return boosted ? Math.round(xp * boostMultiplier) : xp;
}

/** Total XP needed to reach a level. */
export function xpForLevel(level: number): number {
  return config.ticks.levelXpFactor * level * level;
}

/** The level reached with a given total XP. */
export function levelForXp(xp: number): number {
  let level = Math.floor(Math.sqrt(Math.max(0, xp) / config.ticks.levelXpFactor));
  // Guard against floating point error at exact thresholds.
  while (xpForLevel(level + 1) <= xp) level++;
  while (level > 0 && xpForLevel(level) > xp) level--;
  return level;
}
