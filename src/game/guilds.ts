import { config, type GuildId } from '../config.ts';
import { hashString } from '../util/rng.ts';

export interface Hsl {
  /** Hue in degrees, 0 to 360 (exclusive). */
  h: number;
  /** Saturation, 0 to 1. */
  s: number;
  /** Lightness, 0 to 1. */
  l: number;
}

/** Converts `#RRGGBB` to HSL. Returns null if the string is not a hex color. */
export function hexToHsl(color: string): Hsl | null {
  const match = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(color);
  if (!match) return null;
  const r = parseInt(match[1]!, 16) / 255;
  const g = parseInt(match[2]!, 16) / 255;
  const b = parseInt(match[3]!, 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) / 2;
  if (delta === 0) return { h: 0, s: 0, l };

  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

/** The hue of a name color, or null when the color is missing, grey, or too dark or light. */
export function usableHue(color: string | null): number | null {
  if (!color) return null;
  const hsl = hexToHsl(color);
  if (!hsl) return null;
  const { minSaturation, minLightness, maxLightness } = config.guilds;
  if (hsl.s < minSaturation || hsl.l < minLightness || hsl.l > maxLightness) return null;
  return hsl.h;
}

export function guildForHue(hue: number): GuildId {
  for (const guild of config.guilds.list) {
    const inRange =
      guild.fromHue < guild.toHue
        ? hue >= guild.fromHue && hue < guild.toHue
        : hue >= guild.fromHue || hue < guild.toHue;
    if (inRange) return guild.id;
  }
  throw new Error(`The guild hue ranges do not cover hue ${hue}.`);
}

/**
 * The guild for a chatter seen for the first time. Uses the name color when it
 * has a usable hue, otherwise a stable hash of the user id. When the current
 * `guildSizes` are given and the channel is still very small, the chatter is
 * steered into one of the smallest guilds instead. The caller is responsible
 * for the season lock: call this only when no guild is stored.
 */
export function assignGuild(
  color: string | null,
  userId: string,
  guildSizes?: Record<GuildId, number>,
): GuildId {
  const hue = usableHue(color);
  const list = config.guilds.list;
  const hash = hashString(`guild:${userId}`);
  const preferred = hue !== null ? guildForHue(hue) : list[hash % list.length]!.id;
  if (!guildSizes) return preferred;

  // Very small channels: fill the smallest guilds first so none stays empty.
  // The color still decides whenever its guild is among the smallest.
  const known = list.reduce((sum, guild) => sum + guildSizes[guild.id], 0);
  if (known >= config.guilds.balanceBelowChatters) return preferred;
  const smallestSize = Math.min(...list.map((guild) => guildSizes[guild.id]));
  const smallest = list.filter((guild) => guildSizes[guild.id] === smallestSize);
  if (smallest.some((guild) => guild.id === preferred)) return preferred;
  return smallest[hash % smallest.length]!.id;
}
