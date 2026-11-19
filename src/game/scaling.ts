import { config } from '../config.ts';

/**
 * The cost multiplier for a channel with the given number of active chatters
 * per window. 1 at the reference size; smaller channels pay less, larger more,
 * so cities grow at a similar pace everywhere.
 */
export function scaleFor(activeChatters: number): number {
  const { referenceChatters, minScale, maxScale } = config.scaling;
  if (!Number.isFinite(activeChatters) || activeChatters <= 0) return 1;
  return Math.min(maxScale, Math.max(minScale, activeChatters / referenceChatters));
}

/** Applies the channel scale to a point cost. A cost is never below 1. */
export function scaledCost(cost: number, scale: number): number {
  return Math.max(1, Math.round(cost * scale));
}
