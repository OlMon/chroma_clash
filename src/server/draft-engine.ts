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
 * from each guild; free mode draws from everyone. The order drawn is the order
 * in which fighters step onto the field.
 */
export function drawFighters(writers: readonly UserRow[], mode: DraftMode, rng: Rng): UserRow[] {
  // Sorted first, so the draw depends on the seed and not on who wrote first.
  const pool = [...writers].sort((a, b) => (a.user_id < b.user_id ? -1 : 1));
  if (mode === 'free') return shuffle(pool, rng).slice(0, config.draft.freeForAllFighters);
  return config.guilds.list.flatMap((guild) =>
    shuffle(pool.filter((user) => user.guild_id === guild.id), rng).slice(0, config.draft.perGuild),
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
          members: this.picks
            .filter((user) => user.guild_id === guild.id)
            .map((user) => ({ name: user.display_name, detail: this.className(user), id: user.user_id })),
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
      toughness: toughnessFor(free ? 'freeForAll' : 'guildClash', this.picks.length),
      sizeBalance: false,
      fortune: false,
      levelBonus: false,
      field: free ? { total: config.draft.freeForAllOnField } : { perSide: config.draft.onFieldPerGuild },
      sides: free
        ? this.picks.map((user) => ({ id: user.user_id, damageBonus: 0, healthBonus: 0 }))
        : config.guilds.list.map((guild) => ({ id: guild.id, damageBonus: 0, healthBonus: 0 })),
      fighters: this.picks.map((user) => ({
        id: user.user_id,
        name: user.display_name,
        color: user.color,
        emote: user.emote_id,
        class: this.classes.get(user.user_id),
        side: free ? user.user_id : user.guild_id,
        level: 0,
      })),
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
    // The crown goes to the winning guild's fighter with the most kills.
    let most = -1;
    for (const fighter of result.fighters) {
      if (fighter.side !== result.winner || fighter.kills <= most) continue;
      most = fighter.kills;
      this.champion = this.picks.find((user) => user.user_id === fighter.id) ?? null;
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
