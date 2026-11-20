import { config, type GuildId } from '../config.ts';
import type { Store } from '../db/store.ts';
import type { BattleResult, BattleSetup } from '../game/battle.ts';
import { defenseBonus, levelAfterCapture } from '../game/land.ts';
import { battleOrder, chooseTarget } from '../game/war.ts';
import { createRng, type Rng } from '../util/rng.ts';
import type { BattleMeta } from './battle-runner.ts';
import type { EventMap, EventOutcome } from './event-runner.ts';
import { prepareBattle, toughnessFor } from './battles.ts';
import { guildName, languageOf, translator } from '../i18n.ts';

export interface WarStep {
  position: number;
  total: number;
  attacker: GuildId;
  kind: 'attack' | 'skirmish' | 'skipped';
  /** Why the battle does not take place, for a skipped step. */
  reason?: string;
  tileId?: string;
  defender?: GuildId;
  /** Short texts for the overlay's announcement. */
  title: string;
  subtitle: string;
  label: string;
  seed: number;
  map?: EventMap;
  setup?: BattleSetup;
  meta?: BattleMeta;
}

export interface WarOutcome {
  position: number;
  attacker: GuildId;
  defender: GuildId | null;
  kind: WarStep['kind'];
  winner: GuildId | null;
  captured: boolean;
  /** One sentence for the War's summary. */
  text: string;
  /** What the overlay's map shows after the battle. */
  display?: EventOutcome;
}

/**
 * The rules of one War, without clock or timers: which battle comes next, and
 * what its result changes. The caller runs each battle and reports the result.
 */
export class WarEngine {
  readonly warId: number;
  readonly outcomes: WarOutcome[] = [];
  private readonly store: Store;
  private readonly now: () => number;
  private readonly rng: Rng;
  private readonly order: GuildId[];
  private readonly wins: Record<GuildId, number> = { red: 0, green: 0, blue: 0 };
  /** Everyone who was eligible to fight at some point in the War, with their guild. */
  private readonly participants = new Map<string, GuildId>();
  private index = 0;
  private finished = false;
  /** The texts of this War, in the language chosen when it started. */
  private readonly t: ReturnType<typeof translator>;
  private readonly guild: (id: GuildId) => string;

  constructor(store: Store, now: () => number, seed: number) {
    const lang = languageOf(store);
    this.t = translator(lang);
    this.guild = (id) => guildName(lang, id);
    this.store = store;
    this.now = now;
    this.rng = createRng(seed);
    this.order = battleOrder(store.mapTiles(), this.rng);
    this.warId = store.createWar(now(), seed);
  }

  get done(): boolean {
    return this.index >= this.order.length;
  }

  /** The next battle, a skipped step, or null when the War is over. */
  next(): WarStep | null {
    if (this.done) return null;
    const attacker = this.order[this.index]!;
    this.index++;
    const base = {
      position: this.index,
      total: this.order.length,
      attacker,
      title: this.t('server.war.battleOf', { n: this.index, total: this.order.length }),
      label: this.t('server.war.label', { n: this.index, total: this.order.length }),
      seed: Math.floor(this.rng() * 2 ** 31),
    };

    const since = this.now() - config.server.activeWindowMs;
    for (const user of this.store.recentlyActive(since, this.now())) this.participants.set(user.user_id, user.guild_id);

    const target = chooseTarget(this.store.mapTiles(), attacker, this.rng);
    if (!target) {
      return this.skipped(base, this.t('server.war.noTile', { guild: this.guild(attacker) }));
    }

    const sides: GuildId[] =
      target.kind === 'attack'
        ? [attacker, target.defender]
        : [attacker, ...config.guilds.list.map((g) => g.id).filter((id) => id !== attacker)];
    // A developed tile is the stake: named in the title, and what it means in the subtitle.
    const level = target.tile.level ?? 0;
    const staked = target.kind === 'attack' && level > 0;
    const title =
      target.kind === 'attack'
        ? this.t(staked ? 'server.war.attacksLevel' : 'server.war.attacks', { attacker: this.guild(attacker), defender: this.guild(target.defender), level })
        : this.t('server.war.raids', { attacker: this.guild(attacker) });
    const stake =
      target.kind === 'attack' && staked
        ? this.t('server.war.stake', {
            attack: title,
            kept: levelAfterCapture(level),
            defender: this.guild(target.defender),
            bonus: Math.round(defenseBonus(level) * 100),
          })
        : title;
    const { setup, meta } = prepareBattle(this.store, {
      title,
      sides,
      defender: target.kind === 'attack' ? target.defender : undefined,
      tileId: target.tile.id,
      seed: base.seed,
      now: this.now(),
    });
    setup.toughness = toughnessFor('war', setup.fighters.length);
    if (!setup.fighters.some((f) => f.side === attacker)) {
      return this.skipped(base, this.t('server.war.noFighters', { guild: this.guild(attacker) }));
    }

    return {
      ...base,
      kind: target.kind,
      tileId: target.tile.id,
      defender: target.kind === 'attack' ? target.defender : undefined,
      subtitle: target.kind === 'attack' ? stake : this.t('server.war.raidSubtitle', { title }),
      map: { targets: [{ tile: target.tile.id, by: attacker }] },
      setup,
      meta,
    };
  }

  private skipped(base: Omit<WarStep, 'kind' | 'subtitle'>, reason: string): WarStep {
    const step: WarStep = { ...base, kind: 'skipped', reason, subtitle: this.t('server.war.skipped', { reason }) };
    this.store.insertBattle({
      warId: this.warId,
      position: step.position,
      kind: 'skipped',
      tileId: null,
      attacker: step.attacker,
      defender: null,
      winner: null,
      captured: false,
      endedBy: null,
      durationMs: null,
      seed: step.seed,
    });
    this.outcomes.push({
      position: step.position,
      attacker: step.attacker,
      defender: null,
      kind: 'skipped',
      winner: null,
      captured: false,
      text: this.t('server.war.didNotAttack', { guild: this.guild(step.attacker) }),
    });
    return step;
  }

  /** Applies a finished battle: tile capture, statistics, and the record of the battle. */
  apply(step: WarStep, result: BattleResult): WarOutcome {
    const winner = (result.winner as GuildId | null) ?? null;
    const captured = winner === step.attacker && step.tileId !== undefined;
    const attacker = this.guild(step.attacker);
    let text: string;
    if (step.kind === 'attack') {
      const defender = this.guild(step.defender!);
      text = captured
        ? this.t('server.war.tookTile', { attacker, defender })
        : this.t('server.war.held', { attacker, defender });
    } else {
      text = captured ? this.t('server.war.tookNeutral', { attacker }) : this.t('server.war.raidFailed', { attacker });
    }

    this.store.transaction(() => {
      // Land taken by force loses part of its development.
      if (captured) this.store.setTileOwner(step.tileId!, step.attacker, false, true);
      this.store.addFightStats(result.fighters);
      this.store.insertBattle({
        warId: this.warId,
        position: step.position,
        kind: step.kind,
        tileId: step.tileId ?? null,
        attacker: step.attacker,
        defender: step.defender ?? null,
        winner,
        captured,
        endedBy: result.endedBy,
        durationMs: result.durationMs,
        seed: step.seed,
      });
    });
    if (winner) this.wins[winner]++;

    const outcome: WarOutcome = {
      position: step.position,
      attacker: step.attacker,
      defender: step.defender ?? null,
      kind: step.kind,
      winner,
      captured,
      text,
      display: {
        title: text,
        subtitle: this.t('server.war.battleOf', { n: step.position, total: step.total }),
        map: captured
          ? { changes: [{ tile: step.tileId!, from: step.defender ?? null, to: step.attacker, scorched: false }] }
          : { held: [step.tileId!] },
      },
    };
    this.outcomes.push(outcome);
    return outcome;
  }

  /**
   * Ends the War: everyone who was eligible gets the participation XP, plus a
   * bonus for each battle their guild won. Safe to call once; later calls do nothing.
   */
  finish(): { rewarded: number } {
    if (this.finished) return { rewarded: 0 };
    // A War stopped early leaves its remaining attacks unfought.
    this.finished = true;
    const { participationXp, winXp } = config.war;
    this.store.transaction(() => {
      for (const [userId, guildId] of this.participants) {
        this.store.addXp(userId, participationXp + winXp * this.wins[guildId]);
      }
      this.store.endWar(this.warId, this.now());
    });
    return { rewarded: this.participants.size };
  }

  closing(): { title: string; subtitle: string; map: EventMap } {
    return { title: this.t('server.war.over'), subtitle: this.summary(), map: {} };
  }

  /** One line for the overlay when the War is over. */
  summary(): string {
    return this.outcomes.map((outcome) => outcome.text).join(' · ');
  }
}
