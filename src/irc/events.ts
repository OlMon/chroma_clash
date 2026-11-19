import type { IrcMessage } from './parser.ts';

export interface Badge {
  name: string;
  version: string;
}

/** A chat message, reduced to what the game needs. */
export interface ChatMessageEvent {
  type: 'chat';
  /** Channel login without the leading `#`. */
  channel: string;
  /** Stable Twitch user id; the primary key for a chatter. */
  userId: string;
  login: string;
  displayName: string;
  /** Name color as `#RRGGBB`, or null when the chatter never set one. */
  color: string | null;
  badges: Badge[];
  isBroadcaster: boolean;
  isModerator: boolean;
  text: string;
  /**
   * Ids of the Twitch emotes in the message, in the order they were last used:
   * the final entry is the emote nearest the end of the message.
   */
  emoteIds: string[];
  /**
   * Where the last Twitch emote of `emoteIds` starts in the text, counted in
   * characters. Lets a later BetterTTV, FrankerFaceZ or 7TV emote win over it.
   */
  lastEmoteAt?: number;
  /** The channel's Twitch user id, from the `room-id` tag; it is needed to load the channel's own emotes. */
  roomId?: string | null;
  /**
   * The emote this message leaves the chatter with, as a source-qualified id
   * (`twitch:25`, `7tv:<id>`), when the caller worked it out. Without it, the
   * last Twitch emote counts.
   */
  emote?: string | null;
  /** Milliseconds since the Unix epoch, from Twitch when available. */
  sentAt: number;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const ACTION = /^\u0001ACTION (.*)\u0001$/s;

const EMOTE_ID = /^[A-Za-z0-9_]+$/;

/**
 * Parses the `emotes` tag, e.g. `25:0-4,12-16/1902:6-10`: emote id, then the
 * character ranges where it appears. Returns the ids ordered by their last
 * appearance in the message.
 */
export function parseEmotes(value: string | undefined): string[] {
  if (!value) return [];
  const found: { id: string; last: number }[] = [];
  for (const part of value.split('/')) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    const id = part.slice(0, colon);
    if (!EMOTE_ID.test(id)) continue;
    let last = -1;
    for (const range of part.slice(colon + 1).split(',')) {
      const start = Number(range.split('-')[0]);
      if (Number.isFinite(start) && start > last) last = start;
    }
    if (last >= 0) found.push({ id, last });
  }
  return found.sort((a, b) => a.last - b.last).map((emote) => emote.id);
}

/** Where the last emote in the `emotes` tag starts, in characters; -1 when there is none. */
export function lastEmoteStart(value: string | undefined): number {
  let last = -1;
  for (const part of (value ?? '').split('/')) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    for (const range of part.slice(colon + 1).split(',')) {
      const start = Number(range.split('-')[0]);
      if (Number.isFinite(start) && start > last) last = start;
    }
  }
  return last;
}

export function parseBadges(value: string | undefined): Badge[] {
  if (!value) return [];
  const badges: Badge[] = [];
  for (const part of value.split(',')) {
    if (part === '') continue;
    const slash = part.indexOf('/');
    badges.push(
      slash === -1
        ? { name: part, version: '' }
        : { name: part.slice(0, slash), version: part.slice(slash + 1) },
    );
  }
  return badges;
}

/**
 * Converts a PRIVMSG into a chat event. Returns null for other commands and for
 * messages without a `user-id` tag. `receivedAt` is used when Twitch sent no
 * usable timestamp; it is passed in so this function stays pure.
 */
export function toChatEvent(message: IrcMessage, receivedAt: number): ChatMessageEvent | null {
  if (message.command !== 'PRIVMSG') return null;
  const target = message.params[0];
  const body = message.params[1];
  const userId = message.tags['user-id'];
  if (target === undefined || body === undefined || !userId) return null;

  const login = (message.nick ?? '').toLowerCase();
  const displayName = message.tags['display-name'] || login;
  if (displayName === '') return null;

  const colorTag = message.tags['color'] ?? '';
  const badges = parseBadges(message.tags['badges']);
  const sentTs = Number(message.tags['tmi-sent-ts']);
  const action = ACTION.exec(body);

  return {
    type: 'chat',
    channel: target.replace(/^#/, ''),
    userId,
    login: login || displayName.toLowerCase(),
    displayName,
    color: HEX_COLOR.test(colorTag) ? colorTag.toUpperCase() : null,
    badges,
    isBroadcaster: badges.some((b) => b.name === 'broadcaster'),
    isModerator: message.tags['mod'] === '1' || badges.some((b) => b.name === 'moderator'),
    text: action ? action[1]! : body,
    emoteIds: parseEmotes(message.tags['emotes']),
    lastEmoteAt: lastEmoteStart(message.tags['emotes']),
    roomId: message.tags['room-id'] || null,
    sentAt: Number.isFinite(sentTs) && sentTs > 0 ? sentTs : receivedAt,
  };
}
