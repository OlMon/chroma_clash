import { config } from '../config.ts';
import type { Badge, ChatMessageEvent } from '../irc/events.ts';
import { createRng, pick, type Rng } from '../util/rng.ts';

/** The named colors Twitch offers every user in the chat settings. */
export const TWITCH_DEFAULT_COLORS = [
  '#FF0000', '#0000FF', '#008000', '#B22222', '#FF7F50',
  '#9ACD32', '#FF4500', '#2E8B57', '#DAA520', '#D2691E',
  '#5F9EA0', '#1E90FF', '#FF69B4', '#8A2BE2', '#00FF7F',
] as const;

const NAME_FIRST = ['Sleepy', 'Turbo', 'Salty', 'Cosmic', 'Tiny', 'Grumpy', 'Lucky', 'Pixel', 'Mellow', 'Rusty'];
const NAME_SECOND = ['Otter', 'Wizard', 'Pigeon', 'Goblin', 'Panda', 'Raven', 'Badger', 'Noodle', 'Falcon', 'Moth'];
const PHRASES = [
  'hi chat', 'LUL', 'gg', 'that was close', 'what game is this?', 'first time here',
  'nice one', 'no way', 'hello from Germany', 'clip that', 'brb', 'this music is great',
];

/** A few global Twitch emotes (Kappa, LUL, HeyGuys, ...) for simulated messages. */
export const SIM_EMOTES = [
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
] as const;

export type SimRole = 'chatter' | 'moderator' | 'broadcaster' | 'bot';

export interface SimChatter {
  userId: string;
  login: string;
  displayName: string;
  color: string | null;
  role: SimRole;
  messagesPerMinute: number;
  /** The emote this chatter uses most, or null if they never use emotes. */
  favoriteEmote: string | null;
}

export interface SimOptions {
  seed: number;
  channel: string;
  /** Simulated time at which chat begins, in ms since the Unix epoch. */
  startAt: number;
  chatterCount?: number;
  moderatorCount?: number;
  botNames?: readonly string[];
  noColorShare?: number;
  defaultColorShare?: number;
  /**
   * Words of BetterTTV or 7TV emotes the simulated chatters may use too, once
   * those sets are loaded. Without any, only Twitch emotes are used.
   */
  extraEmoteWords?: () => readonly string[];
}

interface ChatterState {
  chatter: SimChatter;
  rng: Rng;
  nextAt: number;
}

function randomHexColor(rng: Rng): string {
  const value = Math.floor(rng() * 0x1000000);
  return `#${value.toString(16).padStart(6, '0').toUpperCase()}`;
}

function badgesFor(role: SimRole): Badge[] {
  if (role === 'broadcaster') return [{ name: 'broadcaster', version: '1' }];
  if (role === 'moderator' || role === 'bot') return [{ name: 'moderator', version: '1' }];
  return [];
}

/**
 * A deterministic fake chat. It has no clock of its own: call `advanceTo` with
 * a simulated time and it returns every message up to that time, in order.
 * The result depends only on the seed and options, not on how time is sliced.
 */
export class SimulatedChat {
  readonly channel: string;
  readonly chatters: readonly SimChatter[];
  private readonly states: ChatterState[];
  private readonly extraEmoteWords: (() => readonly string[]) | null;
  private time: number;

  constructor(options: SimOptions) {
    const sim = config.sim;
    const chatterCount = options.chatterCount ?? sim.chatterCount;
    const moderatorCount = options.moderatorCount ?? sim.moderatorCount;
    const botNames = options.botNames ?? sim.botNames;
    const noColorShare = options.noColorShare ?? sim.noColorShare;
    const defaultColorShare = options.defaultColorShare ?? sim.defaultColorShare;

    this.channel = options.channel.replace(/^#/, '').toLowerCase();
    this.extraEmoteWords = options.extraEmoteWords ?? null;
    this.time = options.startAt;
    this.states = [];

    const add = (index: number, displayName: string, role: SimRole): void => {
      // Each chatter has an own generator, so results do not depend on call order.
      const rng = createRng(options.seed * 7919 + index);
      let color: string | null = null;
      if (rng() >= noColorShare) {
        color = rng() < defaultColorShare ? pick(rng, TWITCH_DEFAULT_COLORS) : randomHexColor(rng);
      }
      const { minPerMinute, spreadPerMinute, skew } = sim.rate;
      const chatter: SimChatter = {
        userId: String(100_000 + index),
        login: displayName.toLowerCase(),
        displayName,
        color,
        role,
        messagesPerMinute: minPerMinute + spreadPerMinute * rng() ** skew,
        favoriteEmote: rng() < sim.noEmoteShare ? null : pick(rng, SIM_EMOTES).id,
      };
      const state: ChatterState = { chatter, rng, nextAt: options.startAt };
      state.nextAt += this.gap(state);
      this.states.push(state);
    };

    let index = 0;
    add(index++, this.channel, 'broadcaster');
    for (const name of botNames) add(index++, name, 'bot');
    const nameRng = createRng(options.seed);
    for (let i = 0; i < chatterCount; i++) {
      const name = `${pick(nameRng, NAME_FIRST)}${pick(nameRng, NAME_SECOND)}${i}`;
      add(index++, name, i < moderatorCount ? 'moderator' : 'chatter');
    }
    this.chatters = this.states.map((state) => state.chatter);
  }

  /** Time until the chatter's next message: exponential, so messages form a Poisson process. */
  private gap(state: ChatterState): number {
    const meanMs = 60_000 / state.chatter.messagesPerMinute;
    return Math.max(1, Math.round(-Math.log(1 - state.rng()) * meanMs));
  }

  /** Returns all messages after the previous call's time up to and including `time`. */
  advanceTo(time: number): ChatMessageEvent[] {
    const events: ChatMessageEvent[] = [];
    for (const state of this.states) {
      while (state.nextAt <= time) {
        const { chatter } = state;
        const badges = badgesFor(chatter.role);
        // Roll for an emote before the text so the sequence of rolls is fixed.
        const usesEmote = chatter.favoriteEmote !== null && state.rng() < config.sim.emoteShare;
        const emoteId = usesEmote
          ? state.rng() < 0.7
            ? chatter.favoriteEmote!
            : pick(state.rng, SIM_EMOTES).id
          : null;
        const phrase = pick(state.rng, PHRASES);
        let emoteName: string | undefined = SIM_EMOTES.find((emote) => emote.id === emoteId)?.name;
        let twitchId = emoteId;
        // Now and then a third-party emote instead. Rolled only when there are any,
        // so a simulation without them stays exactly as it was.
        const extra = usesEmote ? (this.extraEmoteWords?.() ?? []) : [];
        if (extra.length > 0 && state.rng() < 0.3) {
          emoteName = pick(state.rng, extra);
          twitchId = null;
        }
        events.push({
          type: 'chat',
          channel: this.channel,
          userId: chatter.userId,
          login: chatter.login,
          displayName: chatter.displayName,
          color: chatter.color,
          badges,
          isBroadcaster: chatter.role === 'broadcaster',
          isModerator: chatter.role === 'moderator' || chatter.role === 'bot',
          text: emoteName ? `${phrase} ${emoteName}` : phrase,
          emoteIds: twitchId ? [twitchId] : [],
          // The emote follows the phrase and a space.
          ...(twitchId ? { lastEmoteAt: Array.from(phrase).length + 1 } : {}),
          sentAt: state.nextAt,
        });
        state.nextAt += this.gap(state);
      }
    }
    if (time > this.time) this.time = time;
    return events.sort((a, b) => a.sentAt - b.sentAt || a.userId.localeCompare(b.userId));
  }
}

export interface SimDriverOptions extends Omit<SimOptions, 'startAt'> {
  /** Simulated seconds per real second. */
  speed?: number;
  /**
   * Where the simulated clock starts; the real clock by default. A sped-up
   * simulation runs ahead of the real clock, so a simulation that continues a
   * database starts where that one stopped, not back in its past.
   */
  startAt?: number;
  onChat: (event: ChatMessageEvent) => void;
}

/**
 * Runs a SimulatedChat against the real clock, with the same start/stop shape
 * as the IRC client so the two can be swapped.
 */
export class SimulatedChatSource {
  readonly chat: SimulatedChat;
  private readonly options: SimDriverOptions;
  private readonly simStart: number;
  private realStart = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SimDriverOptions) {
    this.options = options;
    this.simStart = Math.max(Date.now(), options.startAt ?? 0);
    this.chat = new SimulatedChat({ ...options, startAt: this.simStart });
  }

  /** The current simulated time. Use this instead of the real clock when a speed is set. */
  now(): number {
    if (this.realStart === 0) return this.simStart;
    return this.simStart + (Date.now() - this.realStart) * (this.options.speed ?? 1);
  }

  start(): void {
    if (this.timer) return;
    this.realStart = Date.now();
    this.timer = setInterval(() => {
      for (const event of this.chat.advanceTo(this.now())) this.options.onChat(event);
    }, config.sim.driverIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
