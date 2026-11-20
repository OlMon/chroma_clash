import { config, type GuildId } from '../config.ts';
import type { Store, UserRow } from '../db/store.ts';
import {
  assignClasses,
  selectFighters,
  type BattleSetup,
  type FighterSpec,
  type SideSpec,
} from '../game/battle.ts';
import { defenseBonus } from '../game/land.ts';
import { createRng } from '../util/rng.ts';
import type { BattleMeta } from './battle-runner.ts';
import { guildName, languageOf, translator } from '../i18n.ts';

/**
 * How tough every fighter is in a kind of fight with this many fighters: see
 * `config.pace`. The god counts as one.
 */
export function toughnessFor(kind: keyof typeof config.pace.kinds, fighters: number): number {
  const { toughness, exponent } = config.pace.kinds[kind];
  return toughness * (config.pace.reference / Math.max(1, fighters)) ** exponent;
}

export interface BattlePlan {
  title: string;
  /** The guilds that take part, attacker first. */
  sides: GuildId[];
  /** The defending guild and the contested tile, if any. The tile's development helps the defender. */
  defender?: GuildId;
  tileId?: string;
  seed: number;
  now: number;
}

/** How a guild short of the team size is filled up: see `config.smallChat`. */
export interface TeamFill {
  /** Its chatters who wrote earlier this session, the latest first. */
  previous: UserRow[];
  /** Chatters the god multiplies: one double each. */
  doubled: UserRow[];
  /** How many of the streamer's imps fill what is still empty. */
  imps: number;
}

/**
 * The team size every guild that fights gets: as many as the largest guild
 * brings, at least `minTeam`, at most `max`.
 */
export function teamTarget(counts: readonly number[], max: number): number {
  return Math.min(max, Math.max(config.smallChat.minTeam, ...counts));
}

/**
 * Fills one guild up to `target`: with `previous` chatters first (in the
 * order given), then doubles of its chatters, then imps, never more imps than
 * it has chatters. `chatters` are those already in. A guild without anyone sits out.
 */
export function fillTeam(chatters: readonly UserRow[], previous: readonly UserRow[], target: number): TeamFill {
  const fill: TeamFill = { previous: [], doubled: [], imps: 0 };
  if (chatters.length === 0 && previous.length === 0) return fill;
  fill.previous = previous.slice(0, Math.max(0, target - chatters.length));
  const people = [...chatters, ...fill.previous];
  let count = people.length;
  for (let round = 0; round < config.smallChat.clonesPerChatter && count < target; round++) {
    for (const user of people) {
      if (count >= target) break;
      fill.doubled.push(user);
      count++;
    }
  }
  fill.imps = Math.min(Math.max(0, target - count), people.length);
  return fill;
}

/** The chatters of a guild who wrote this session but not lately: most recent first. */
export function previousChatters(store: Store, guildId: GuildId, exclude: ReadonlySet<string>, now: number): UserRow[] {
  const session = store.activeSession();
  if (!session) return [];
  return store
    .recentWriters(session.started_at - 1, now)
    .filter((user) => user.guild_id === guildId && !exclude.has(user.user_id))
    .sort((a, b) => b.last_seen - a.last_seen);
}

/** A double the god makes of a chatter: their look, weaker, in their place. */
export function doubleOf(user: UserRow, side: string, n = 1): FighterSpec {
  return {
    id: `double:${user.user_id}:${n}`,
    name: user.display_name,
    color: user.color,
    emote: user.emote_id,
    side,
    level: user.level,
    doubleOf: user.user_id,
    strength: config.smallChat.cloneStrength,
  };
}

/** One of the streamer's imps filling a guild's place. */
export function impOf(guildId: GuildId, n: number, lang: string): FighterSpec {
  return {
    id: `imp:${guildId}:${n}`,
    name: translator(lang)('server.imp.name', { n }),
    color: null,
    class: null,
    side: guildId,
    level: 0,
    imp: true,
    strength: config.smallChat.impStrength,
  };
}

/**
 * Turns a plan into a battle setup from the current game state: who is
 * eligible, who is drawn when a side is over the cap, each side's bonuses,
 * and how small guilds are filled up (see `config.smallChat`).
 */
export function prepareBattle(store: Store, plan: BattlePlan): { setup: BattleSetup; meta: BattleMeta } {
  const rng = createRng(plan.seed);
  const session = store.activeSession();
  const lang = languageOf(store);
  const active = store.recentlyActive(plan.now - config.server.activeWindowMs, plan.now);
  const championId = store.champion()?.user_id ?? null;
  const tile = plan.tileId ? store.tiles().find((t) => t.tile_id === plan.tileId) : undefined;

  // Who each guild brings, then the team size they are all filled up to.
  const picks = new Map<GuildId, UserRow[]>();
  for (const guildId of plan.sides) {
    const eligible = active.filter((user) => user.guild_id === guildId).map((user) => ({ ...user, id: user.user_id }));
    const heroes = new Set(session ? store.heroIds(session.session_id, guildId, config.battle.heroesPerGuild) : []);
    picks.set(guildId, selectFighters(eligible, heroes, rng));
  }
  const target = teamTarget([...picks.values()].map((p) => p.length), config.smallChat.teamSize);
  const taken = new Set(active.map((user) => user.user_id));

  const sides: SideSpec[] = [];
  const fighters: FighterSpec[] = [];
  const doubles: FighterSpec[] = [];
  for (const guildId of plan.sides) {
    const picked = picks.get(guildId)!;
    const fill = fillTeam(picked, previousChatters(store, guildId, taken, plan.now), target);
    const leads = fill.doubled.length > 0 || fill.imps > 0;
    for (const user of [...picked, ...fill.previous]) {
      fighters.push({
        id: user.user_id,
        name: user.display_name,
        color: user.color,
        emote: user.emote_id,
        crown: user.user_id === championId,
        side: guildId,
        level: user.level,
        // The chatters of a guild filled up with doubles or imps lead them: a little stronger, under a banner.
        ...(leads ? { leader: true, strength: config.smallChat.leaderStrength } : {}),
      });
    }
    fill.doubled.forEach((user, i) => doubles.push(doubleOf(user, guildId, 1 + Math.floor(i / Math.max(1, picked.length + fill.previous.length)))));
    for (let n = 1; n <= fill.imps; n++) fighters.push(impOf(guildId, n, lang));

  // A defender fights on its own land: the more developed the tile, the tougher its fighters.
    const defending = plan.defender === guildId && tile !== undefined;
    sides.push({
      id: guildId,
      damageBonus: 0,
      healthBonus: defending ? defenseBonus(tile.level) : 0,
    });
  }

  // Every chatter is dealt a class for this fight; a double fights with its chatter's.
  assignClasses(fighters, rng);
  for (const double of doubles) {
    double.class = fighters.find((f) => f.id === double.doubleOf)?.class ?? null;
    fighters.push(double);
  }

  return {
    setup: { seed: plan.seed, sides, fighters },
    meta: {
      title: plan.title,
      sides: config.guilds.list
        .filter((guild) => plan.sides.includes(guild.id))
        .map((guild) => ({ id: guild.id, name: guildName(languageOf(store), guild.id), color: guild.color })),
    },
  };
}
