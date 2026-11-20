import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config, type GuildId } from '../../src/config.ts';
import { Store } from '../../src/db/store.ts';
import { Battle, type BattleResult } from '../../src/game/battle.ts';
import { prepareBattle } from '../../src/server/battles.ts';
import { ClashEngine } from '../../src/server/clash-engine.ts';
import type { Lineup } from '../../src/server/draft-engine.ts';

const T0 = 1_700_000_100_000;
const COLORS: Record<GuildId, string> = { red: '#FF0000', green: '#00FF00', blue: '#0000FF' };

/** A store with a session and chatters who wrote at `at`, in the named guilds. */
function chatStore(perGuild: Partial<Record<GuildId, number>>, at = T0 + 1_000): Store {
  const store = Store.open(':memory:');
  store.setManualChatters(config.scaling.referenceChatters * 100);
  store.startSession(T0);
  let id = 1000;
  for (const [guild, count] of Object.entries(perGuild) as [GuildId, number][]) {
    for (let i = 0; i < count; i++) {
      id++;
      store.recordMessage({
        type: 'chat', channel: 'test', userId: String(id), login: `u${id}`, displayName: `U${id}`, color: COLORS[guild],
        badges: [], isBroadcaster: false, isModerator: false, text: 'hi', emoteIds: [], sentAt: at + id,
      });
      // Colors decide the guild only past the small-channel balancing: pin it.
      store.db.prepare('UPDATE users SET guild_id = ? WHERE user_id = ?').run(guild, String(id));
    }
  }
  return store;
}

const plan = (sides: GuildId[], now = T0 + 60_000) => ({ title: 'War', sides, seed: 3, now });

test('a small guild is filled up with the streamer\'s imps, weaker, led by its chatters under banners', () => {
  const store = chatStore({ red: 2, blue: 9 });
  const { setup } = prepareBattle(store, plan(['red', 'blue']));
  const { floor, impStrength, leaderStrength } = config.smallChat;
  const red = setup.fighters.filter((f) => f.side === 'red');
  assert.equal(red.length, floor, 'red is filled up to the floor');
  assert.equal(red.filter((f) => f.imp).length, floor - 2);
  assert.ok(red.filter((f) => f.imp).every((f) => f.strength === impStrength && f.class === null));
  assert.ok(red.filter((f) => !f.imp).every((f) => f.leader && f.strength === leaderStrength), 'the chatters lead them');
  const blue = setup.fighters.filter((f) => f.side === 'blue');
  assert.equal(blue.length, 9, 'a guild at or above the floor gets no imps');
  assert.ok(blue.every((f) => !f.imp && !f.leader && f.strength === undefined));

  // In the battle the imps are weaker and the leaders a little stronger than an ordinary chatter.
  const battle = new Battle({ ...setup, sizeBalance: false, fortune: false, levelBonus: false });
  const plain = config.battle.baseHealth;
  const imp = battle.fighters.find((f) => f.imp)!;
  assert.ok(Math.abs(imp.maxHealth - plain * impStrength) < 1e-6, `an imp has ${imp.maxHealth}`);
  assert.ok(Math.abs(imp.damage - config.battle.baseDamage * impStrength) < 1e-6);
  const leader = battle.fighters.find((f) => f.leader)!;
  const cls = config.classes[leader.class!];
  assert.ok(Math.abs(leader.damage - config.battle.baseDamage * cls.damage * leaderStrength) < 1e-6, 'a leader hits a little harder');
  store.close();
});

test('a guild nobody fights for gets no imps', () => {
  const store = chatStore({ red: 3, blue: 3 });
  const { setup } = prepareBattle(store, plan(['red', 'green', 'blue']));
  assert.equal(setup.fighters.filter((f) => f.side === 'green').length, 0);
  store.close();
});

test('a small chat draws from everyone who wrote this session, a busy one from the last half hour', () => {
  const later = T0 + 2 * 60 * 60_000;
  const quiet = chatStore({ red: 3, blue: 3 });
  assert.equal(prepareBattle(quiet, plan(['red', 'blue'], later)).setup.fighters.filter((f) => !f.imp).length, 6, 'all six, though they wrote two hours ago');
  quiet.close();

  // Twelve wrote a minute ago; four more wrote two hours ago and are left out.
  const busy = chatStore({ red: 6, blue: 6 }, later - 60_000);
  for (let id = 1; id <= 4; id++) {
    busy.recordMessage({
      type: 'chat', channel: 'test', userId: `old${id}`, login: `old${id}`, displayName: `Old${id}`, color: COLORS.red,
      badges: [], isBroadcaster: false, isModerator: false, text: 'hi', emoteIds: [], sentAt: T0 + id,
    });
    busy.db.prepare("UPDATE users SET guild_id = 'red' WHERE user_id = ?").run(`old${id}`);
  }
  const drawn = prepareBattle(busy, plan(['red', 'blue'], later)).setup.fighters;
  assert.equal(drawn.length, 12, 'enough chat: only the last half hour counts');
  assert.ok(drawn.every((f) => !f.id.startsWith('old')));
  busy.close();
});

test('a Hero Clash heat without a hero of a guild gets an imp; an imp that wins a heat sends nobody on', () => {
  const store = chatStore({ red: 3, blue: 1 });
  // Ticks in a few windows, so the heroes rank.
  const engine = new ClashEngine(store, () => T0 + 60_000, 4);
  assert.equal(engine.heats.length, 3, 'one heat per rank that has a hero');
  for (const heat of engine.heats) assert.equal(heat.length, 3, 'every guild is in every heat');
  const last = engine.heats[2]!;
  assert.equal(last.filter((entrant) => 'guild' in entrant).length, 2, 'blue and green send imps to the third heat');

  // Play the heats, letting an imp win the first one.
  const first = engine.next()!;
  const impSide = first.setup!.fighters.find((f) => f.imp)!.side;
  assert.ok(first.setup!.fighters.filter((f) => f.imp).every((f) => f.strength === config.smallChat.impStrength));
  assert.ok((first.lineup as Lineup).teams.some((team) => team.members[0]!.imp));
  engine.apply(first, { winner: impSide } as BattleResult);
  assert.ok(first.heroes.every((hero) => !hero.user_id.startsWith('imp:')), 'imps are not heroes');
  store.close();
});
