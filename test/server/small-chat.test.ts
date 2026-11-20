import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config, type GuildId } from '../../src/config.ts';
import { Store, type UserRow } from '../../src/db/store.ts';
import { Battle, type BattleResult } from '../../src/game/battle.ts';
import { fillTeam, prepareBattle, teamTarget } from '../../src/server/battles.ts';
import { ClashEngine } from '../../src/server/clash-engine.ts';
import { DraftEngine, type Lineup } from '../../src/server/draft-engine.ts';

const T0 = 1_700_000_100_000;
const COLORS: Record<GuildId, string> = { red: '#FF0000', green: '#00FF00', blue: '#0000FF' };

/** Records a message from a chatter pinned to a guild. */
function write(store: Store, id: string, guild: GuildId, at: number): void {
  store.recordMessage({
    type: 'chat', channel: 'test', userId: id, login: `u${id}`, displayName: `U${id}`, color: COLORS[guild],
    badges: [], isBroadcaster: false, isModerator: false, text: 'hi', emoteIds: [], sentAt: at,
  });
  // Colors decide the guild only past the small-channel balancing: pin it.
  store.db.prepare('UPDATE users SET guild_id = ? WHERE user_id = ?').run(guild, id);
}

/** A store with a session and chatters who wrote at `at`, in the named guilds. */
function chatStore(perGuild: Partial<Record<GuildId, number>>, at = T0 + 1_000): Store {
  const store = Store.open(':memory:');
  store.setManualChatters(config.scaling.referenceChatters * 100);
  store.startSession(T0);
  let id = 1000;
  for (const [guild, count] of Object.entries(perGuild) as [GuildId, number][]) {
    for (let i = 0; i < count; i++) write(store, String(++id), guild, at + id);
  }
  return store;
}

const plan = (sides: GuildId[], now = T0 + 60_000) => ({ title: 'War', sides, seed: 3, now });

test('the team size follows the largest guild, between the smallest team and the cap', () => {
  assert.equal(teamTarget([1, 2], 6), config.smallChat.minTeam, 'two tiny guilds fight three a side');
  assert.equal(teamTarget([4, 2], 6), 4);
  assert.equal(teamTarget([20, 2], 6), 6);
  const lone = { user_id: 'a' } as UserRow;
  const early = { user_id: 'b' } as UserRow;
  assert.deepEqual(fillTeam([lone], [], 3), { previous: [], doubled: [lone], imps: 1 }, 'one chatter: a double and one imp');
  assert.deepEqual(fillTeam([lone], [early], 3), { previous: [early], doubled: [lone], imps: 0 }, 'an earlier chatter before any double');
  assert.deepEqual(fillTeam([], [], 3), { previous: [], doubled: [], imps: 0 }, 'nobody: the guild sits out');
  assert.equal(fillTeam([lone], [], 6).imps, 1, 'never more imps than chatters, even if the team stays short');
});

test('a short guild is filled up: earlier chatters first, then doubles, imps only last', () => {
  const { teamSize, impStrength, cloneStrength, leaderStrength } = config.smallChat;
  // Red: one chatter now and one who wrote 55 minutes earlier; blue: nine now.
  const now = T0 + 61 * 60_000;
  const store = chatStore({ red: 1, blue: 9 }, T0 + 60 * 60_000);
  write(store, 'early', 'red', T0 + 5_000);
  const { setup } = prepareBattle(store, plan(['red', 'blue'], now));
  const red = setup.fighters.filter((f) => f.side === 'red');
  assert.equal(red.length, teamSize, 'red fills up to the team size');
  const chatters = red.filter((f) => !f.imp && !f.doubleOf);
  assert.deepEqual(chatters.map((f) => f.id).sort(), ['1001', 'early'], 'the one who wrote an hour ago fights too');
  const doubles = red.filter((f) => f.doubleOf);
  assert.equal(doubles.length, 2, 'the god doubles each of them once');
  for (const double of doubles) {
    assert.equal(double.strength, cloneStrength);
    assert.equal(double.class, chatters.find((c) => c.id === double.doubleOf)!.class, "a double fights with its chatter's class");
  }
  const imps = red.filter((f) => f.imp);
  assert.equal(imps.length, 2, 'imps take what is left, no more than the guild has chatters');
  assert.ok(imps.every((f) => f.strength === impStrength));
  assert.ok(chatters.every((f) => f.leader && f.strength === leaderStrength), 'the chatters lead them');
  const blue = setup.fighters.filter((f) => f.side === 'blue');
  assert.equal(blue.length, 9);
  assert.ok(blue.every((f) => !f.imp && !f.doubleOf && !f.leader));

  // In the battle the doubles start beside their chatter, and imps are weaker.
  const battle = new Battle({ ...setup, sizeBalance: false, fortune: false, levelBonus: false });
  for (const double of battle.fighters.filter((f) => f.doubleOf)) {
    const original = battle.fighters.find((f) => f.id === double.doubleOf)!;
    assert.ok(Math.hypot(double.x - original.x, double.y - original.y) < original.radius * 3, 'beside its chatter');
  }
  const imp = battle.fighters.find((f) => f.imp)!;
  assert.ok(Math.abs(imp.maxHealth - config.battle.baseHealth * impStrength) < 1e-6);
  store.close();
});

test('guilds of even size are not filled up, and a guild nobody fights for gets nothing', () => {
  const even = chatStore({ red: 4, blue: 4 });
  assert.ok(prepareBattle(even, plan(['red', 'blue'])).setup.fighters.every((f) => !f.imp && !f.doubleOf && !f.leader));
  even.close();
  const store = chatStore({ red: 3, blue: 3 });
  assert.equal(prepareBattle(store, plan(['red', 'green', 'blue'])).setup.fighters.filter((f) => f.side === 'green').length, 0);
  store.close();
});

test('a Guild Clash fills a short guild the same way and lists the doubles in the line-up', () => {
  const store = chatStore({ red: 1, blue: 5 });
  const picks = store.recentlyActive(0);
  const engine = new DraftEngine(store, () => T0 + 60_000, 3, 'guild', picks);
  assert.equal(engine.doubles.length, 1, 'the lonely red chatter is doubled');
  assert.equal(engine.imps.length, 1, 'one imp, as many as red has chatters');
  const red = engine.lineup().teams.find((team) => team.color === config.guilds.list[0]!.color)!;
  assert.equal(red.members.length, 3);
  assert.ok(red.members.some((m) => m.double) && red.members.some((m) => m.imp));
  const step = engine.next()!;
  const double = step.setup!.fighters.find((f) => f.doubleOf)!;
  assert.equal(double.strength, config.smallChat.cloneStrength);
  store.close();
});

test('a Hero Clash heat without a hero of a guild gets an imp; an imp that wins a heat sends nobody on', () => {
  const store = chatStore({ red: 3, blue: 1 });
  const engine = new ClashEngine(store, () => T0 + 60_000, 4);
  assert.equal(engine.heats.length, 3, 'one heat per rank that has a hero');
  for (const heat of engine.heats) assert.equal(heat.length, 3, 'every guild is in every heat');
  const last = engine.heats[2]!;
  assert.equal(last.filter((entrant) => 'guild' in entrant).length, 2, 'blue and green send imps to the third heat');

  const first = engine.next()!;
  const impSide = first.setup!.fighters.find((f) => f.imp)!.side;
  assert.ok(first.setup!.fighters.filter((f) => f.imp).every((f) => f.strength === config.smallChat.impStrength));
  assert.ok((first.lineup as Lineup).teams.some((team) => team.members[0]!.imp));
  engine.apply(first, { winner: impSide } as BattleResult);
  assert.ok(first.heroes.every((hero) => !hero.user_id.startsWith('imp:')), 'imps are not heroes');
  store.close();
});
