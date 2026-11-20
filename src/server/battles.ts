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

/**
 * Turns a plan into a battle setup from the current game state: who is
 * eligible, who is drawn when a side is over the cap, and each side's bonuses.
 */
export function prepareBattle(store: Store, plan: BattlePlan): { setup: BattleSetup; meta: BattleMeta } {
  const rng = createRng(plan.seed);
  const session = store.activeSession();
  // A small chat draws from everyone who wrote this session, not only the last half hour.
  const since = plan.now - config.server.activeWindowMs;
  let active = store.recentlyActive(since, plan.now);
  if (active.length < config.smallChat.widenBelow && session) active = store.recentlyActive(Math.min(since, session.started_at), plan.now);
  const t = translator(languageOf(store));
  const championId = store.champion()?.user_id ?? null;
  const tile = plan.tileId ? store.tiles().find((t) => t.tile_id === plan.tileId) : undefined;

  const sides: SideSpec[] = [];
  const fighters: FighterSpec[] = [];
  for (const guildId of plan.sides) {
    const eligible = active.filter((user) => user.guild_id === guildId).map((user) => ({ ...user, id: user.user_id }));
    const heroes = new Set(
      session ? store.heroIds(session.session_id, guildId, config.battle.heroesPerGuild) : [],
    );
    const picked: (UserRow & { id: string })[] = selectFighters(eligible, heroes, rng);
    // A guild with too few chatters is filled up with the streamer's imps, weaker than chatters;
    // the chatters lead them, a little stronger and under a banner.
    const { floor, impStrength, leaderStrength } = config.smallChat;
    const imps = picked.length > 0 ? Math.max(0, floor - picked.length) : 0;
    for (const user of picked) {
      fighters.push({
        id: user.user_id,
        name: user.display_name,
        color: user.color,
        emote: user.emote_id,
        crown: user.user_id === championId,
        side: guildId,
        level: user.level,
        ...(imps > 0 ? { leader: true, strength: leaderStrength } : {}),
      });
    }
    for (let n = 1; n <= imps; n++) {
      fighters.push({ id: `imp:${guildId}:${n}`, name: t('server.imp.name', { n }), color: null, class: null, side: guildId, level: 0, imp: true, strength: impStrength });
    }

    // A defender fights on its own land: the more developed the tile, the tougher its fighters.
    const defending = plan.defender === guildId && tile !== undefined;
    sides.push({
      id: guildId,
      damageBonus: 0,
      healthBonus: defending ? defenseBonus(tile.level) : 0,
    });
  }

  // Every chatter is dealt a class for this fight.
  assignClasses(fighters, rng);

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
