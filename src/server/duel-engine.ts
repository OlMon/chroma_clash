import { config, type ClassId, type GuildId } from '../config.ts';
import type { Store, UserRow } from '../db/store.ts';
import { assignClasses, type BattleResult, type BattleSetup, type FighterSpec } from '../game/battle.ts';
import { guildName, languageOf, translator } from '../i18n.ts';
import { createRng, type Rng } from '../util/rng.ts';
import type { BattleMeta } from './battle-runner.ts';
import { toughnessFor } from './battles.ts';
import type { Lineup } from './draft-engine.ts';
import type { EventEngine, EventStep } from './event-runner.ts';

export interface DuelStep extends EventStep {
  kind: 'duel';
}

/** A duel's line-up: the two face to face. The overlay shows it as a "VS" screen. */
export interface DuelLineup extends Lineup {
  duel: true;
}

const guildOf = (id: GuildId) => config.guilds.list.find((g) => g.id === id)!;

/**
 * The second duelist when the streamer leaves it to the lot: from the
 * `candidates`, not `other`, and from another guild than `other` when there
 * is one, so the two look different on screen. With neither chosen, `other`
 * is null and the first is drawn from everyone.
 */
export function drawDuelist(candidates: readonly UserRow[], other: UserRow | null, rng: Rng): UserRow | null {
  // Sorted first, so the draw depends on the seed and not on who wrote last.
  const pool = [...candidates].filter((user) => user.user_id !== other?.user_id).sort((a, b) => (a.user_id < b.user_id ? -1 : 1));
  const elsewhere = other ? pool.filter((user) => user.guild_id !== other.guild_id) : [];
  const from = elsewhere.length > 0 ? elsewhere : pool;
  return from.length === 0 ? null : from[Math.floor(rng() * from.length)]!;
}

/**
 * Two chatters, one on one: shown face to face, then a single fight. Both
 * start with the same class, dealt by lot, each switching to another now and
 * then, and with equal stats: levels,
 * buildings, size balance and fortune do not apply, and every hit lands a
 * little harder or softer by chance (see `config.duel`). It changes nothing
 * in the game: the season only counts the winner's duel wins, for the recap.
 */
export class DuelEngine implements EventEngine<DuelStep> {
  readonly duelists: [UserRow, UserRow];
  /** The class both start with. */
  cls: ClassId;
  winner: UserRow | null = null;
  /** The winner's health left at the end, from 0 to 1. */
  private healthLeft = 0;
  private started = false;
  private finished = false;
  private readonly store: Store;
  private readonly now: () => number;
  private readonly seed: number;
  private readonly lang: string;
  private readonly t: ReturnType<typeof translator>;

  constructor(store: Store, now: () => number, seed: number, a: UserRow, b: UserRow) {
    this.store = store;
    this.now = now;
    this.seed = seed;
    this.lang = languageOf(store);
    this.t = translator(this.lang);
    this.duelists = [a, b];
    // Dealt at the start, so the line-up can show it: one class, by the usual shares, for both.
    const dealt: FighterSpec[] = [{ id: a.user_id, name: a.display_name, color: null, side: a.user_id, level: 0 }];
    assignClasses(dealt, createRng(seed + 1));
    this.cls = dealt[0]!.class!;
  }

  /** Each duelist's color on screen: their guild's, or, when both are in the same guild, the second one's own name color. */
  private colorOf(user: UserRow): string {
    const [a, b] = this.duelists;
    if (user === b && a.guild_id === b.guild_id && user.color) return user.color;
    return guildOf(user.guild_id!).color;
  }

  lineup(): DuelLineup {
    return {
      duel: true,
      teams: this.duelists.map((user) => ({
        name: guildName(this.lang, user.guild_id!),
        color: this.colorOf(user),
        members: [{ name: user.display_name, detail: this.t(`class.${this.cls}`), id: user.user_id }],
      })),
      note: this.t('server.duel.note'),
    };
  }

  next(): DuelStep | null {
    if (this.started) return null;
    this.started = true;
    const title = this.t('mode.duel');
    const { duel } = config;
    const setup: BattleSetup = {
      seed: this.seed,
      durationMs: duel.durationMs,
      toughness: toughnessFor('duel', 2),
      classSwitch: { everyMs: duel.switchEveryMs },
      overtime: duel.overtime,
      hitSpread: duel.hitSpread,
      // Bumpers, spike traps and barrels, and plenty of them; no walls: two this large would get stuck behind one.
      obstacles: 'hazards',
      sizeBalance: false,
      fortune: false,
      levelBonus: false,
      sides: this.duelists.map((user) => ({ id: user.user_id, damageBonus: 0, healthBonus: 0 })),
      fighters: this.duelists.map((user): FighterSpec => ({
        id: user.user_id,
        name: user.display_name,
        color: user.color,
        emote: user.emote_id,
        class: this.cls,
        side: user.user_id,
        level: 0,
        radius: duel.radius,
      })),
    };
    const meta: BattleMeta = {
      title,
      duel: true,
      sides: this.duelists.map((user) => ({ id: user.user_id, name: user.display_name, color: this.colorOf(user) })),
    };
    const [a, b] = this.duelists;
    return {
      kind: 'duel',
      title: this.t('server.duel.title', { a: a.display_name, b: b.display_name }),
      subtitle: this.t('server.duel.note'),
      label: title,
      holdMs: duel.lineupMs,
      lineup: this.lineup(),
      setup,
      meta,
    };
  }

  apply(_step: DuelStep, result: BattleResult): void {
    this.winner = this.duelists.find((user) => user.user_id === result.winner) ?? null;
    this.healthLeft = result.fighters.find((f) => f.id === result.winner)?.healthLeft ?? 0;
  }

  /** Counts the winner's duel win for the season. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.winner) this.store.noteDuelWin(this.winner, this.now());
  }

  closing(): { title: string; subtitle: string } {
    if (!this.winner) return { title: this.t('mode.duel'), subtitle: this.t('server.duel.draw') };
    const loser = this.duelists.find((user) => user !== this.winner)!;
    const wins = this.store.duelWins(this.winner.user_id, this.now());
    const percent = Math.max(1, Math.round(this.healthLeft * 100));
    const parts = [this.t('server.duel.against', { name: loser.display_name, percent })];
    if (wins > 1) parts.push(this.t('server.duel.seasonWins', { count: wins }));
    return { title: this.t('server.duel.wins', { name: this.winner.display_name }), subtitle: parts.join(' · ') };
  }
}
