import { toughnessFor } from './battles.ts';
import { config, type GuildId } from '../config.ts';
import type { Store, UserRow } from '../db/store.ts';
import { assignClasses, type BattleResult, type FighterSpec } from '../game/battle.ts';
import { createRng, type Rng } from '../util/rng.ts';
import type { EventEngine, EventMap, EventStep } from './event-runner.ts';
import { guildName, languageOf, translator } from '../i18n.ts';
import type { Lineup } from './draft-engine.ts';

export interface ClashStep extends EventStep {
  kind: 'heat' | 'final' | 'skipped';
  /** The heroes in this match. */
  heroes: UserRow[];
}

const guildOf = (id: GuildId) => config.guilds.list.find((g) => g.id === id)!;

/**
 * Hero Clash: the most active chatters of each guild in the running session
 * fight three three-way heats and a final, all with equal stats. The
 * champion's guild earns boosted XP for a while.
 */
export class ClashEngine implements EventEngine<ClashStep> {
  /** Heat by heat: the first-ranked hero of each guild, then the second, then the third. */
  readonly heats: UserRow[][];
  champion: UserRow | null = null;
  /** The neutral tile the champion's guild took as its prize, or null if none was neutral. */
  prize: string | null = null;
  private readonly store: Store;
  private readonly now: () => number;
  private readonly rng: Rng;
  private readonly seed: number;
  private readonly sessionId: number;
  private readonly startedAt: number;
  private readonly winners: UserRow[] = [];
  private heatIndex = 0;
  private finalStarted = false;
  private finished = false;
  /** The texts of this Hero Clash, in the language chosen when it started. */
  private readonly lang: string;
  private readonly t: ReturnType<typeof translator>;

  /** Throws an Error with a message for the streamer if no Hero Clash can start. */
  constructor(store: Store, now: () => number, seed: number) {
    this.lang = languageOf(store);
    this.t = translator(this.lang);
    const session = store.activeSession();
    if (!session) throw new Error(this.t('server.clash.needsLayer'));
    this.store = store;
    this.now = now;
    this.seed = seed;
    this.rng = createRng(seed);
    this.sessionId = session.session_id;
    this.startedAt = now();

    const { heroesPerGuild } = config.clash;
    const ranked = config.guilds.list.map((guild) =>
      store
        .heroIds(session.session_id, guild.id, heroesPerGuild)
        .map((id) => store.getUser(id))
        .filter((user): user is UserRow => user !== null),
    );
    this.heats = [];
    for (let rank = 0; rank < heroesPerGuild; rank++) {
      const heat = ranked.map((heroes) => heroes[rank]).filter((hero): hero is UserRow => hero !== undefined);
      if (heat.length > 0) this.heats.push(heat);
    }
    if (this.heats.length === 0) {
      throw new Error(this.t('server.clash.needsTicks'));
    }
  }

  next(): ClashStep | null {
    if (this.heatIndex < this.heats.length) {
      const heroes = this.heats[this.heatIndex]!;
      this.heatIndex++;
      const heat = { n: this.heatIndex, total: this.heats.length };
      return this.match('heat', this.t('server.clash.heatTitle', heat), this.t('server.clash.heatBattle', heat), heroes);
    }
    if (this.finalStarted) return null;
    this.finalStarted = true;
    if (this.winners.length === 0) return null;
    if (this.winners.length === 1) {
      // Only one heat produced a winner: no final is needed.
      this.champion = this.winners[0]!;
      return null;
    }
    return this.match('final', this.t('server.clash.finalTitle'), this.t('server.clash.finalBattle'), this.winners);
  }

  /** `title` is the announcement's and the control panel's; `battleTitle` the overlay's during the fight. */
  private match(kind: 'heat' | 'final', title: string, battleTitle: string, heroes: UserRow[]): ClashStep {
    const fighters: FighterSpec[] = heroes.map((hero) => ({
      id: hero.user_id,
      name: hero.display_name,
      color: hero.color,
      emote: hero.emote_id,
      side: hero.user_id,
      level: 0,
    }));
    // A class is dealt anew for each match.
    assignClasses(fighters, this.rng);
    // The heroes presented before the match: each with their guild, class and emote.
    const lineup: Lineup = {
      teams: heroes.map((hero, index) => ({
        name: guildName(this.lang, hero.guild_id),
        color: guildOf(hero.guild_id).color,
        members: [{ name: hero.display_name, detail: this.t(`class.${fighters[index]!.class}`), id: hero.user_id }],
      })),
      note: this.t('server.clash.lineupNote'),
    };
    return {
      kind,
      heroes,
      title,
      subtitle: heroes.map((hero) => hero.display_name).join('  vs  '),
      lineup,
      label: kind === 'final' ? this.t('server.clash.finalLabel') : title,
      // Every hero is a side of their own; apart from the class each was dealt, they are equal.
      setup: {
        seed: Math.floor(this.rng() * 2 ** 31),
        durationMs: config.clash.matchMs,
        toughness: toughnessFor('heroClash', fighters.length),
        sizeBalance: false,
        fortune: false,
        levelBonus: false,
        sides: heroes.map((hero) => ({ id: hero.user_id, damageBonus: 0, healthBonus: 0 })),
        fighters,
      },
      meta: {
        title: battleTitle,
        sides: heroes.map((hero) => ({
          id: hero.user_id,
          name: hero.display_name,
          color: guildOf(hero.guild_id).color,
        })),
      },
    };
  }

  apply(step: ClashStep, result: BattleResult): void {
    const winner = step.heroes.find((hero) => hero.user_id === result.winner) ?? null;
    if (step.kind === 'final') this.champion = winner;
    else if (winner) this.winners.push(winner);
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    // A clash stopped before its end has no champion.
    const complete = this.heatIndex >= this.heats.length && (this.finalStarted || this.winners.length <= 1);
    const champion = complete ? (this.champion ?? (this.winners.length === 1 ? this.winners[0]! : null)) : null;
    this.champion = champion;
    this.store.transaction(() => {
      this.store.insertClash(this.sessionId, this.startedAt, this.seed, champion);
      if (!champion) return;
      this.store.setGuildBoost(champion.guild_id, this.now() + config.clash.boostMs);
      // The prize: the neutral tile nearest the champion's city, if there is one.
      this.prize = this.store.nearestNeutralTile(champion.guild_id);
      if (this.prize) this.store.setTileOwner(this.prize, champion.guild_id);
    });
  }

  closing(): { title: string; subtitle: string; map?: EventMap } {
    if (!this.champion) return { title: this.t('mode.heroClash'), subtitle: this.t('server.clash.noChampion') };
    const guild = guildOf(this.champion.guild_id);
    const percent = Math.round((config.ticks.boostMultiplier - 1) * 100);
    const minutes = Math.round(config.clash.boostMs / 60_000);
    const boost = { guild: guildName(this.lang, guild.id), percent, minutes };
    return {
      title: this.t('server.clash.champion', { name: this.champion.display_name }),
      subtitle: this.t(this.prize ? 'server.clash.boostPrize' : 'server.boost', boost),
      // With a prize, the closing shows the map and the tile turning the guild's color.
      ...(this.prize
        ? { map: { changes: [{ tile: this.prize, from: null, to: guild.id, scorched: false }] } }
        : {}),
    };
  }
}
