/**
 * Emote sources and image addresses. A chatter's emote is stored as a
 * source-qualified id, `twitch:25`, `bttv:<id>`, `ffz:<id>` or `7tv:<id>`. A
 * plain id without a source (from older databases) is a Twitch emote.
 */

export type EmoteSource = 'twitch' | 'bttv' | 'ffz' | '7tv';
/** The sources that are not in Twitch's own `emotes` tag; each can be switched off. */
export type ThirdPartySource = 'bttv' | 'ffz' | '7tv';

export const EMOTE_SOURCES: EmoteSource[] = ['twitch', 'bttv', 'ffz', '7tv'];
export const THIRD_PARTY_SOURCES: ThirdPartySource[] = ['bttv', 'ffz', '7tv'];

/** An emote id as the services use them: letters, digits, dashes and underscores. */
const EMOTE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidEmoteId(id: string): boolean {
  return EMOTE_ID.test(id);
}

export function isEmoteSource(value: unknown): value is EmoteSource {
  return typeof value === 'string' && (EMOTE_SOURCES as string[]).includes(value);
}

export interface EmoteRef {
  source: EmoteSource;
  id: string;
}

/** Reads a stored emote. A plain id is a Twitch emote. Returns null for anything malformed. */
export function parseEmoteRef(value: string | null | undefined): EmoteRef | null {
  if (!value) return null;
  const colon = value.indexOf(':');
  const source = colon === -1 ? 'twitch' : value.slice(0, colon);
  const id = colon === -1 ? value : value.slice(colon + 1);
  if (!isEmoteSource(source) || !isValidEmoteId(id)) return null;
  return { source, id };
}

export function formatEmoteRef(ref: EmoteRef): string {
  return `${ref.source}:${ref.id}`;
}

/** What the overlay loads for a fighter's emote: same-origin addresses on the game server. */
export interface EmoteImage {
  url: string;
  /** The moving version, or null when the emote does not move. */
  animatedUrl: string | null;
}

/**
 * The game server's addresses for an emote. Twitch does not say whether an
 * emote moves; only its newer `emotesv2_` emotes can, so those get an
 * animated address, which serves the still image when the emote does not move.
 */
export function emoteImage(ref: EmoteRef, animated: boolean | undefined): EmoteImage {
  const base = `/emotes/${ref.source}/${encodeURIComponent(ref.id)}`;
  const moves = ref.source === 'twitch' ? ref.id.startsWith('emotesv2_') : animated === true;
  return { url: `${base}?animated=0`, animatedUrl: moves ? `${base}?animated=1` : null };
}

/**
 * The image files to try for an emote on its source's CDN, in order, at
 * double size. A still image of a moving emote and the image of an emote that
 * never moves live at different addresses, so both are tried.
 */
export function cdnCandidates(ref: EmoteRef, animated: boolean): string[] {
  const id = encodeURIComponent(ref.id);
  switch (ref.source) {
    case 'twitch': {
      const base = `https://static-cdn.jtvnw.net/emoticons/v2/${id}`;
      return animated ? [`${base}/default/dark/2.0`, `${base}/static/dark/2.0`] : [`${base}/static/dark/2.0`];
    }
    case 'bttv': {
      const base = `https://cdn.betterttv.net/emote/${id}`;
      return animated ? [`${base}/2x.webp`] : [`${base}/static/2x.webp`, `${base}/2x.webp`];
    }
    case 'ffz': {
      const base = `https://cdn.frankerfacez.com/emote/${id}`;
      return animated ? [`${base}/animated/2`, `${base}/2`] : [`${base}/2`];
    }
    case '7tv': {
      const base = `https://cdn.7tv.app/emote/${id}`;
      return animated ? [`${base}/2x.webp`] : [`${base}/2x_static.webp`, `${base}/2x.webp`];
    }
  }
}

/** The image type from a file's first bytes, or null if it is not an image the overlay can show. */
export function imageType(data: Uint8Array): string | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...data.subarray(start, end));
  if (data.length >= 8 && data[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (data.length >= 6 && ascii(0, 4) === 'GIF8') return 'image/gif';
  if (data.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (data.length >= 12 && ascii(4, 8) === 'ftyp' && ascii(8, 12).startsWith('avi')) return 'image/avif';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  return null;
}

/**
 * A few of Twitch's global emotes. Twitch's full global list needs a login;
 * these are enough as a pool for chatters who never used an emote.
 */
export const TWITCH_GLOBALS: { id: string; name: string }[] = [
  { id: '25', name: 'Kappa' },
  { id: '425618', name: 'LUL' },
  { id: '30259', name: 'HeyGuys' },
  { id: '64138', name: 'SeemsGood' },
  { id: '58765', name: 'NotLikeThis' },
  { id: '86', name: 'BibleThump' },
  { id: '245', name: 'ResidentSleeper' },
  { id: '28087', name: 'WutFace' },
  { id: '114836', name: 'Jebaited' },
  { id: '41', name: 'Kreygasm' },
];
