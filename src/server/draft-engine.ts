import type { EmoteImage } from '../emotes/sources.ts';
import { toughnessFor } from './battles.ts';
import { config, type ClassId, type GuildId } from '../config.ts';
import type { Store, UserRow } from '../db/store.ts';
import { assignClasses, type BattleResult, type BattleSetup, type FighterSpec } from '../game/battle.ts';
import { createRng, type Rng } from '../util/rng.ts';
import type { BattleMeta } from './battle-runner.ts';
import type { EventEngine, EventMap, EventStep } from './event-runner.ts';
import { DEFAULT_LANGUAGE, guildName, languageOf, translator } from '../i18n.ts';

/** `guild`: three guilds with a bench each. `free`: everyone for themselves. `pachinko`: drawn like `guild`, then Pachinko. */
export type DraftMode = 'guild' | 'free' | 'pachinko';

/** What the overlay lists before the fight. `detail` is a second line per fighter: its class. */
/**
 * Who fights, as the overlay presents them before a fight. `id` is the
 * chatter's; the server adds each one's emote (`emote`) and name color
 * (`color`) before sending, so the overlay can show them beside the name.
 */
export interface LineupMember {
  name: string;
  detail: string;
  id?: string;
  /** One of the streamer's imps, filling a place no chatter took: drawn as a small imp. */
  imp?: boolean;
  emote?: EmoteImage | null;
  color?: string | null;
}

export interface Lineup {
  teams: { name: string; color: string; members: LineupMember[] }[];
  note: string;
}

export interface DraftStep extends EventStep {
  kind: 'draft';
}

const guildOf = (id: GuildId) => config.guilds.list.find((g) => g.id === id)!;

function shuffle<T>(items: T[], rng: Rng): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/**
 * Draws the fighters from the chatters who wrote during the countdown: by lot,
 * so a slow connection is no disadvantage. Guild mode draws up to `perGuild`
 * from each guild; free mode draws from everyone. Where the countdown's
 * writers do not fill the places, `backups` do (chatters who wrote shortly
 * before it, see `config.draft.recentMs`): writers always come first. The
 * order drawn is the order in which fighters step onto the field.
 */
export function drawFighters(writers: readonly UserRow[], mode: DraftMode, rng: Rng, backups: readonly UserRow[] = []): UserRow[] {
  // Sorted first, so the draw depends on the seed and not on who wrote first.
  const sorted = (users: readonly UserRow[]) => [...users].sort((a, b) => (a.user_id < b.user_id ? -1 : 1));
  const taken = new Set(writers.map((user) => user.user_id));
  const first = sorted(writers);
  const second = sorted(backups.filter((user) => !taken.has(user.user_id)));
  const draw = (pick: (user: UserRow) => boolean, places: number) =>
    [...shuffle(first.filter(pick), rng), ...shuffle(second.filter(pick), rng)].slice(0, places);
  if (mode === 'free') return draw(() => true, config.draft.freeForAllFighters);
  return config.guilds.list.flatMap((guild) => draw((user) => user.guild_id === guild.id, config.draft.perGuild));
}

/**
 * One of the streamer's imps: when a guild drew fewer chatters than the
 * others, the streamer lends it imps in its color for the empty places.
 */
export interface Imp {
  id: string;
  name: string;
  guild: GuildId;
}

/**
 * The imps that fill each guild's empty places: every guild with at least one
 * chatter drawn gets as many places as the largest guild, and at least
 * `atLeast`. A guild nobody drew for sits the game out.
 */
export function impsFor(picks: readonly UserRow[], atLeast: number, lang = DEFAULT_LANGUAGE): Imp[] {
  const t = translator(lang);
  const counts = config.guilds.list.map((guild) => ({
    guild: guild.id,
    count: picks.filter((user) => user.guild_id === guild.id).length,
  }));
  const places = Math.max(atLeast, ...counts.map((c) => c.count));
  return counts.flatMap(({ guild, count }) =>
    count === 0
      ? []
      : Array.from({ length: Math.max(0, places - count) }, (_, i) => ({ id: `imp:${guild}:${i + 1}`, name: t('server.imp.name', { n: i + 1 }), guild })),
  );
}

/** Why a draw cannot fight, as a message for the overlay in the given language, or null if it can. */
export function drawProblem(picks: readonly UserRow[], mode: DraftMode, lang = DEFAULT_LANGUAGE): string | null {
  const t = translator(lang);
  if (mode === 'free') return picks.length >= 2 ? null : t('server.draft.freeNeedsTwo');
  const guilds = new Set(picks.map((user) => user.guild_id));
  if (guilds.size >= 2) return null;
  return t(mode === 'pachinko' ? 'server.draft.pachinkoNeedsGuilds' : 'server.draft.guildNeedsGuilds');
}

/**
 * A countdown fight: a few of the drawn chatters are on the field at a time
 * while the rest wait on the bench. Levels, buildings, size balance and
 * fortune do not apply; only the class each fighter was dealt sets them apart.
 */
export class DraftEngine implements EventEngine<DraftStep> {
  readonly mode: DraftMode;
  readonly picks: UserRow[];
  /** Guild mode: the winning guild. Free mode: null. */
  winnerGuild: GuildId | null = null;
  /** The last fighter standing in free mode; the winning guild's top killer in guild mode. */
  champion: UserRow | null = null;
  /** Guild mode: the neutral tile the winning guild took as its prize, or null. */
  prize: string | null = null;
  /** Guild mode: the imps filling the places of guilds that drew fewer chatters. */
  readonly imps: Imp[];
  /** The class each drawn fighter was dealt, shown in the line-up. */
  readonly classes = new Map<string, ClassId>();
  private readonly store: Store;
  private readonly now: () => number;
  private readonly seed: number;
  private readonly startedAt: number;
  private started = false;
  private decided = false;
  private finished = false;
  /** The texts of this fight, in the language chosen when it started. */
  private readonly lang: string;
  private readonly t: ReturnType<typeof translator>;

  constructor(store: Store, now: () => number, seed: number, mode: DraftMode, picks: UserRow[]) {
    this.lang = languageOf(store);
    this.t = translator(this.lang);
    this.store = store;
    this.now = now;
    this.seed = seed;
    this.mode = mode;
    this.picks = picks;
    this.startedAt = now();
    this.imps = mode === 'guild' ? impsFor(picks, config.draft.onFieldPerGuild, this.lang) : [];
    // Classes are dealt at the draw, so the line-up can show them before the fight.
    const dealt: FighterSpec[] = picks.map((user) => ({
      id: user.user_id,
      name: user.display_name,
      color: null,
      side: user.user_id,
      level: 0,
    }));
    assignClasses(dealt, createRng(seed + 1));
    for (const fighter of dealt) this.classes.set(fighter.id, fighter.class!);
  }

  private className(user: UserRow): string {
    return this.t(`class.${this.classes.get(user.user_id)!}`);
  }

  lineup(): Lineup {
    const { onFieldPerGuild, freeForAllOnField } = config.draft;
    if (this.mode === 'free') {
      return {
        teams: [
          {
            name: this.t('mode.freeForAll'),
            color: '#FFFFFF',
            members: this.picks.map((user) => ({ name: user.display_name, detail: this.className(user), id: user.user_id })),
          },
        ],
        note: this.t('server.draft.freeNote', { n: Math.min(freeForAllOnField, this.picks.length) }),
      };
    }
    return {
      teams: config.guilds.list
        .map((guild) => ({
          name: guildName(this.lang, guild.id),
          color: guild.color,
          members: [
            ...this.picks
              .filter((user) => user.guild_id === guild.id)
              .map((user): LineupMember => ({ name: user.display_name, detail: this.className(user), id: user.user_id })),
            ...this.imps
              .filter((imp) => imp.guild === guild.id)
              .map((imp): LineupMember => ({ name: imp.name, detail: this.t('server.imp.detail'), imp: true })),
          ],
        }))
        .filter((team) => team.members.length > 0),
      note: this.t('server.draft.guildNote', { n: onFieldPerGuild }),
    };
  }

  next(): DraftStep | null {
    if (this.started) return null;
    this.started = true;
    const free = this.mode === 'free';
    const title = this.t(free ? 'mode.freeForAll' : 'mode.guildClash');

    const setup: BattleSetup = {
      seed: this.seed,
      durationMs: config.draft.durationMs,
      toughness: toughnessFor(free ? 'freeForAll' : 'guildClash', this.picks.length + this.imps.length),
      sizeBalance: false,
      fortune: false,
      levelBonus: false,
      field: free ? { total: config.draft.freeForAllOnField } : { perSide: config.draft.onFieldPerGuild },
      sides: free
        ? this.picks.map((user) => ({ id: user.user_id, damageBonus: 0, healthBonus: 0 }))
        : config.guilds.list.map((guild) => ({ id: guild.id, damageBonus: 0, healthBonus: 0 })),
      fighters: [
        ...this.picks.map((user): FighterSpec => ({
          id: user.user_id,
          name: user.display_name,
          color: user.color,
          emote: user.emote_id,
          class: this.classes.get(user.user_id),
          side: free ? user.user_id : user.guild_id,
          level: 0,
        })),
        // The imps step in last, after the guild's chatters: plain fighters without a class.
        ...this.imps.map((imp): FighterSpec => ({ id: imp.id, name: imp.name, color: null, class: null, side: imp.guild, level: 0, imp: true })),
      ],
    };
    const meta: BattleMeta = {
      title,
      sides: free
        ? this.picks.map((user) => ({
            id: user.user_id,
            name: user.display_name,
            color: guildOf(user.guild_id).color,
          }))
        : config.guilds.list
            .filter((guild) => this.picks.some((user) => user.guild_id === guild.id))
            .map((guild) => ({ id: guild.id, name: guildName(this.lang, guild.id), color: guild.color })),
    };
    return {
      kind: 'draft',
      title: this.t('server.lineupTitle', { mode: title }),
      subtitle: this.lineup().note,
      label: title,
      holdMs: config.draft.lineupMs,
      lineup: this.lineup(),
      setup,
      meta,
    };
  }

  apply(_step: DraftStep, result: BattleResult): void {
    this.decided = true;
    if (!result.winner) return;
    if (this.mode === 'free') {
      this.champion = this.picks.find((user) => user.user_id === result.winner) ?? null;
      return;
    }
    this.winnerGuild = result.winner as GuildId;
    // The crown goes to the winning guild's chatter with the most kills (never to an imp).
    let most = -1;
    for (const fighter of result.fighters) {
      const user = this.picks.find((pick) => pick.user_id === fighter.id);
      if (!user || fighter.side !== result.winner || fighter.kills <= most) continue;
      most = fighter.kills;
      this.champion = user;
    }
  }

  /**
   * Guild mode is the second mode of Hero Clash and gives its reward: the
   * winning guild's XP boost and the crown. They need a running session. A
   * free-for-all gives nothing: it is for show.
   */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    const session = this.store.activeSession();
    if (!this.decided || this.mode === 'free' || !this.winnerGuild || !session) return;
    this.store.transaction(() => {
      this.store.insertClash(session.session_id, this.startedAt, this.seed, this.champion);
      this.store.setGuildBoost(this.winnerGuild!, this.now() + config.clash.boostMs);
      // The prize: the neutral tile nearest the winning guild's city, if there is one.
      this.prize = this.store.nearestNeutralTile(this.winnerGuild!);
      if (this.prize) this.store.setTileOwner(this.prize, this.winnerGuild!);
    });
  }

  closing(): { title: string; subtitle: string; map?: EventMap } {
    if (this.mode === 'free') {
      return this.champion
        ? { title: this.t('server.draft.freeWins', { name: this.champion.display_name }), subtitle: this.t('server.draft.freeWinsSubtitle') }
        : { title: this.t('mode.freeForAll'), subtitle: this.t('server.noWinner') };
    }
    if (!this.winnerGuild) return { title: this.t('mode.guildClash'), subtitle: this.t('server.noWinner') };
    const percent = Math.round((config.ticks.boostMultiplier - 1) * 100);
    const minutes = Math.round(config.clash.boostMs / 60_000);
    const winner = guildName(this.lang, this.winnerGuild);
    const boost = this.store.activeSession() ? this.t('server.boost', { guild: winner, percent, minutes }) : '';
    const crown = this.champion ? this.t('server.draft.crown', { name: this.champion.display_name }) : '';
    const land = this.prize ? this.t('server.draft.land') : '';
    return {
      title: this.t('server.draft.guildWins', { guild: winner }),
      subtitle: [boost, crown, land].filter(Boolean).join(' · '),
      ...(this.prize
        ? { map: { changes: [{ tile: this.prize, from: null, to: this.winnerGuild, scorched: false }] } }
        : {}),
    };
  }
}
