import assert from 'node:assert/strict';
import type { Lineup } from '../../src/server/draft-engine.ts';
import { test } from 'node:test';
import { config, type GuildId } from '../../src/config.ts';
import { Store, type UserRow } from '../../src/db/store.ts';
import { Battle, godHealth, skillHealthFactor, type BattleResult } from '../../src/game/battle.ts';
import { ClashEngine } from '../../src/server/clash-engine.ts';
import { GodEngine } from '../../src/server/god-engine.ts';

const T0 = 1_700_000_100_000;
const WINDOW = 5 * 60_000;
const COLORS: Record<GuildId, string> = { red: '#FF0000', green: '#00FF00', blue: '#0000FF' };
let nextId = 5000;

function chat(store: Store, guild: GuildId, sentAt: number, userId?: string): string {
  const id = userId ?? String(++nextId);
  store.recordMessage({
    type: 'chat',
    channel: 'test',
    userId: id,
    login: `u${id}`,
    displayName: `U${id}`,
    color: COLORS[guild],
    badges: [],
    isBroadcaster: false,
    isModerator: false,
    text: 'hi',
    emoteIds: [],
    sentAt,
  });
  return id;
}

/** A store with a running session and `perGuild` chatters per guild, all active in the first window. */
function setupStore(perGuild: number): Store {
  const store = Store.open(':memory:');
  store.setManualChatters(config.scaling.referenceChatters * 100);
  store.startSession(T0);
  for (let i = 0; i < perGuild; i++) {
    for (const guild of ['red', 'green', 'blue'] as const) chat(store, guild, T0 + i);
  }
  return store;
}

/** A battle result in which the given team wins, without running a fight. */
function resultFor(setup: { sides: { id: string; team?: string }[]; fighters: { id: string; side: string }[] }, winner: string): BattleResult {
  return {
    winner,
    endedBy: 'elimination',
    durationMs: 10_000,
    sides: setup.sides.map((side, index) => ({
      id: side.id,
      team: side.team ?? side.id,
      fighters: setup.fighters.filter((f) => f.side === side.id).length,
      survivors: (side.team ?? side.id) === winner ? 1 : 0,
      health: 0,
      // Later sides dealt more, so the last chat guild struck hardest per fighter.
      damageDealt: 100 * (index + 1) * setup.fighters.filter((f) => f.side === side.id).length,
    })),
    fighters: setup.fighters.map((f) => ({ id: f.id, side: f.side, kills: 0, alive: true, damageDealt: 0 })),
  };
}

// --- Hero Clash ---------------------------------------------------------------

test('Hero Clash needs a session and chatters with ticks', () => {
  const store = Store.open(':memory:');
  assert.throws(() => new ClashEngine(store, () => T0, 1), /background layer/);
  store.startSession(T0);
  assert.throws(() => new ClashEngine(store, () => T0, 1), /earned ticks/);
  store.close();
});

test('heroes are the most active chatters of each guild, ranked into heats', () => {
  const store = setupStore(5);
  // Give one chatter per guild two extra ticks and another one extra tick.
  const ranked: Record<string, string[]> = {};
  for (const guild of ['red', 'green', 'blue'] as const) {
    const members = store.recentlyActive(0).filter((u) => u.guild_id === guild).map((u) => u.user_id);
    chat(store, guild, T0 + WINDOW, members[3]);
    chat(store, guild, T0 + 2 * WINDOW, members[3]);
    chat(store, guild, T0 + WINDOW, members[1]);
    ranked[guild] = [members[3]!, members[1]!];
  }

  const engine = new ClashEngine(store, () => T0 + 3 * WINDOW, 4);
  assert.equal(engine.heats.length, 3);
  const heroes = (heat: (typeof engine.heats)[number]) => heat.map((h) => h as UserRow);
  assert.deepEqual(heroes(engine.heats[0]!).map((h) => h.user_id).sort(), [ranked.red![0], ranked.green![0], ranked.blue![0]].sort());
  assert.deepEqual(heroes(engine.heats[1]!).map((h) => h.user_id).sort(), [ranked.red![1], ranked.green![1], ranked.blue![1]].sort());
  for (const heat of engine.heats) {
    assert.deepEqual(heroes(heat).map((h) => h.guild_id).sort(), ['blue', 'green', 'red'], 'one hero per guild');
  }
  store.close();
});

test('a clash runs three heats and a final with equal stats, and crowns a champion', () => {
  const store = setupStore(4);
  const now = T0 + WINDOW;
  const engine = new ClashEngine(store, () => now, 9);
  const kinds: string[] = [];
  for (let step = engine.next(); step; step = engine.next()) {
    kinds.push(step.kind);
    // Presented first: each hero with their guild and the class dealt for this match, and their id for the emote.
    const lineup = step.lineup as Lineup;
    assert.deepEqual(lineup.teams.flatMap((t) => t.members.map((m) => m.id)), step.heroes.map((h) => h.user_id));
    step.setup!.fighters.forEach((fighter, i) => assert.equal(lineup.teams[i]!.members[0]!.detail, config.classes.names[fighter.class!]));
    const battle = new Battle(step.setup!);
    assert.equal(battle.durationMs, config.clash.matchMs);
    for (const fighter of battle.fighters) {
      // Only the class each hero was dealt for this match sets them apart: no level, building or balance bonus.
      const stats = config.classes[fighter.class!];
      assert.ok(Math.abs(fighter.maxHealth - config.battle.baseHealth * stats.health * step.setup!.toughness!) < 1e-9);
      assert.ok(Math.abs(fighter.damage - config.battle.baseDamage * stats.damage) < 1e-9);
    }
    engine.apply(step, battle.run());
  }
  engine.finish();
  assert.deepEqual(kinds, ['heat', 'heat', 'heat', 'final']);

  const champion = engine.champion;
  assert.ok(champion);
  assert.equal(store.getUser(champion.user_id)!.clash_wins, 1);
  assert.equal(store.champion()!.user_id, champion.user_id);
  assert.match(engine.closing().title, /is the champion/);

  // The champion's guild, and only that guild, earns boosted XP for 30 minutes.
  for (const guild of ['red', 'green', 'blue'] as const) {
    assert.equal(store.guildBoostActive(guild, now + 1), guild === champion.guild_id);
    assert.equal(store.guildBoostActive(guild, now + config.clash.boostMs + 1), false);
  }
  const before = store.getUser(champion.user_id)!.xp;
  chat(store, champion.guild_id, now + WINDOW, champion.user_id);
  const tileXp = Math.min(config.ticks.maxOwnedTileXp, store.ownedTiles(champion.guild_id) * config.ticks.xpPerOwnedTile);
  const boosted = Math.round((config.ticks.xpPerTick + tileXp) * config.ticks.boostMultiplier);
  assert.equal(store.getUser(champion.user_id)!.xp - before, boosted, 'a boosted tick is worth half as much again');
  store.close();
});

test('a clash that is stopped early has no champion', () => {
  const store = setupStore(4);
  const engine = new ClashEngine(store, () => T0 + WINDOW, 9);
  const step = engine.next()!;
  engine.apply(step, new Battle(step.setup!).run());
  engine.finish();
  assert.equal(engine.champion, null);
  assert.equal(store.champion(), null);
  assert.equal(engine.closing().subtitle, 'No champion this time');
  store.close();
});

// --- God events ---------------------------------------------------------------

/** Makes every tile but the cities neutral. */
function clearLand(store: Store): void {
  for (const tile of store.tiles()) if (!tile.is_city) store.setTileOwner(tile.tile_id, null);
}

test('a Clash champion\'s guild takes the neutral tile nearest its city as a prize', () => {
  const store = setupStore(4);
  assert.equal(store.tiles().find((t) => t.tile_id === '0,0')!.owner_guild_id, null, 'the center starts neutral');
  const engine = new ClashEngine(store, () => T0 + WINDOW, 9);
  for (let step = engine.next(); step; step = engine.next()) engine.apply(step, new Battle(step.setup!).run());
  engine.finish();
  const guild = engine.champion!.guild_id;
  assert.equal(engine.prize, '0,0');
  assert.equal(store.tiles().find((t) => t.tile_id === '0,0')!.owner_guild_id, guild);
  assert.deepEqual(engine.closing().map, { changes: [{ tile: '0,0', from: null, to: guild, scorched: false }] });
  assert.match(engine.closing().subtitle, /takes the neutral tile/);

  // With no neutral tile left, the next champion gets the boost and the crown only.
  const next = new ClashEngine(store, () => T0 + 2 * WINDOW, 10);
  for (let step = next.next(); step; step = next.next()) next.apply(step, new Battle(step.setup!).run());
  next.finish();
  assert.equal(next.prize, null);
  assert.equal(next.closing().map, undefined);
  store.close();
});

test("God's Wrath targets the guild whose Monument is furthest, on its farthest tile", () => {
  const empty = setupStore(6);
  clearLand(empty);
  assert.throws(() => new GodEngine(empty, () => T0, 1, 'wrath', 'streamer'), /owns a tile/);
  empty.close();

  const store = setupStore(6);
  store.addMonument('green', 500);
  const far = new Set<string>();
  for (let seed = 1; seed <= 20; seed++) {
    const engine = new GodEngine(store, () => T0, seed, 'wrath', 'streamer');
    assert.equal(engine.target, 'green', 'green leads the race');
    far.add(engine.tileId!);
  }
  // Green's two tiles farthest from its city; the seed picks between them.
  assert.deepEqual([...far].sort(), ['-1,1', '-2,2']);
  store.close();
});

test("God's Wrath: the god is one large fighter against the leading guild only", () => {
  const store = setupStore(6);
  store.addMonument('red', 500);
  const step = new GodEngine(store, () => T0, 3, 'wrath', 'streamer').next()!;
  const setup = step.setup!;
  const god = setup.fighters[0]!;
  assert.equal(god.id, 'god');
  assert.equal(god.name, 'streamer', 'the channel name until the broadcaster writes in chat');
  assert.deepEqual([...new Set(setup.fighters.slice(1).map((f) => f.side))], ['red']);
  assert.equal(setup.fighters.length, 7);
  assert.equal(setup.timeLimitWinner, 'god');

  // Switching skills off in the control panel reaches the god.
  store.setGodSkill('minions', false);
  store.setGodSkill('rampage', false);
  assert.deepEqual(store.godSkills(), ['shockwave', 'leap', 'vortex', 'smite', 'shield', 'enrage']);
  const fewer = new GodEngine(store, () => T0, 3, 'wrath', 'streamer').next()!.setup!.fighters[0]!;
  assert.deepEqual(fewer.skills, store.godSkills());
  store.setGodSkill('minions', true);
  store.setGodSkill('rampage', true);
  assert.equal(setup.sizeBalance, false);

  // Health follows the formula for six opponents, lowered for the god's skills, within the variation.
  assert.equal(god.skills!.length, 8, 'all skills are on until the streamer switches some off');
  const expected = godHealth(6) * skillHealthFactor(god.skills!);
  assert.ok(god.health! >= expected * 0.7 && god.health! <= expected * 1.3);
  const battle = new Battle(setup);
  assert.ok(battle.fighters[0]!.radius > battle.fighters[1]!.radius * 2);
  assert.ok(['god', 'chat'].includes(battle.run().winner!));
  store.close();
});

test("God's Wrath: a win turns the tile neutral, scorched and half developed; a loss rewards the guild", () => {
  const lost = setupStore(4);
  lost.addMonument('red', 500);
  for (const tile of lost.tiles()) lost.setTileLevel(tile.tile_id, 6);
  let engine = new GodEngine(lost, () => T0, 3, 'wrath', 'streamer');
  const taken = engine.tileId!;
  let step = engine.next()!;
  const shown = engine.apply(step, resultFor(step.setup!, 'god')).display;
  const tile = () => lost.tiles().find((t) => t.tile_id === taken)!;
  assert.deepEqual([tile().owner_guild_id, tile().scorched, tile().level], [null, 1, 3]);
  assert.match(shown.title, /prevails/);
  // The overlay's map is told which tile was under attack and what became of it.
  assert.deepEqual(step.map, { targets: [{ tile: taken, by: 'god' }] });
  assert.deepEqual(shown.map, { changes: [{ tile: taken, from: 'red', to: null, scorched: true }] });
  assert.equal(engine.closing().title, 'streamer 1 : 0 Chat', 'the closing banner is the season score');
  assert.deepEqual(lost.godRecord(1), { seasonWins: 1, seasonLosses: 0, lifetimeWins: 1, lifetimeLosses: 0, friendlyWins: 0, friendlyLosses: 0 });
  // Whoever takes the tile back clears the scorch mark.
  lost.setTileOwner(taken, 'blue');
  assert.deepEqual([tile().owner_guild_id, tile().scorched], ['blue', 0]);
  lost.close();

  const held = setupStore(4);
  held.addMonument('red', 500);
  const xpBefore = new Map(held.recentlyActive(0).map((u) => [u.user_id, u.xp]));
  engine = new GodEngine(held, () => T0, 3, 'wrath', 'streamer');
  step = engine.next()!;
  assert.deepEqual(engine.apply(step, resultFor(step.setup!, 'chat')).display.map, { held: [engine.tileId] });
  assert.equal(held.ownedTiles('red'), 5);
  for (const user of held.recentlyActive(0)) {
    const gained = user.xp - xpBefore.get(user.user_id)!;
    assert.equal(gained, user.guild_id === 'red' ? config.god.winXp : 0);
  }
  assert.deepEqual(held.godRecord(1), { seasonWins: 0, seasonLosses: 1, lifetimeWins: 0, lifetimeLosses: 1, friendlyWins: 0, friendlyLosses: 0 });
  held.close();
});

test('Streamer vs Chat: over the map once per session; a friendly fight any time, changing nothing', () => {
  const store = Store.open(':memory:');
  assert.throws(() => new GodEngine(store, () => T0, 1, 'versus', 'streamer'), /background layer/);
  store.close();

  const active = setupStore(5);
  // A friendly fight before the map fight does not use the map fight up.
  const early = new GodEngine(active, () => T0, 1, 'friendly', 'streamer');
  assert.equal(early.friendly, true);
  const earlyStep = early.next()!;
  early.apply(earlyStep, resultFor(earlyStep.setup!, 'chat'));
  assert.equal(active.activeSession()!.versus_used, 0);

  const engine = new GodEngine(active, () => T0, 2, 'versus', 'streamer');
  const step = engine.next()!;
  assert.equal(engine.next(), null, 'a god event is a single battle');
  const chatSides = step.setup!.sides.filter((s) => s.id !== 'god');
  assert.deepEqual(chatSides.map((s) => s.id).sort(), ['blue', 'green', 'red']);
  assert.ok(chatSides.every((s) => s.team === 'chat'));
  // The god, and five chatters per guild filled up with imps to the small-chat floor.
  assert.equal(step.setup!.fighters.length, 1 + 3 * Math.max(5, config.smallChat.floor));
  assert.equal(step.map!.targets!.length, 3, 'one tile per guild is at stake');
  assert.equal(engine.friendly, false);
  engine.apply(step, resultFor(step.setup!, 'chat'));

  // The map fight cannot be repeated in the session; the error points to the friendly fight.
  assert.throws(() => new GodEngine(active, () => T0, 3, 'versus', 'streamer'), /once per session.*friendly fight in the Arena/);

  // A friendly fight: nothing at stake, nothing changed, counted apart.
  const snapshot = () =>
    JSON.stringify([active.tiles(), active.monuments(), active.recentlyActive(0).map((u) => [u.xp, u.kills, u.battles])]);
  const before = snapshot();
  const friendly = new GodEngine(active, () => T0, 3, 'friendly', 'streamer');
  assert.equal(friendly.friendly, true);
  assert.equal(friendly.kind, 'versus', 'the same event, with nothing at stake');
  const friendlyStep = friendly.next()!;
  assert.match(friendlyStep.title, /friendly/);
  assert.deepEqual(friendlyStep.map, { targets: [] }, 'no tile is marked as at stake');
  assert.equal(friendlyStep.setup!.fighters.length, step.setup!.fighters.length, 'the fight itself is the same');
  const shown = friendly.apply(friendlyStep, resultFor(friendlyStep.setup!, 'god')).display;
  assert.match(shown.subtitle, /nothing was at stake/);
  assert.deepEqual(shown.map, {});
  assert.equal(snapshot(), before, 'a god win costs chat nothing in a friendly fight');
  assert.deepEqual(active.godRecord(1), {
    seasonWins: 0,
    seasonLosses: 1,
    lifetimeWins: 0,
    lifetimeLosses: 1,
    friendlyWins: 1,
    friendlyLosses: 1,
  });
  assert.equal(friendly.closing().title, 'streamer 1 : 1 Chat');
  assert.equal(friendly.closing().subtitle, 'Friendly fights this season');

  // A new session: the map fight is available again.
  active.endSession(T0 + WINDOW);
  active.startSession(T0 + 2 * WINDOW);
  assert.equal(new GodEngine(active, () => T0 + 2 * WINDOW, 3, 'versus', 'streamer').friendly, false);

  // Without a running session there is no friendly fight either.
  active.endSession(T0 + 3 * WINDOW);
  assert.throws(() => new GodEngine(active, () => T0 + 3 * WINDOW, 4, 'friendly', 'streamer'), /background layer/);
  active.close();
});

test('Streamer vs Chat: if the god wins, every guild loses a tile and every Monument part of its progress', () => {
  const store = setupStore(4);
  store.addMonument('red', 1000);
  store.addMonument('green', 400);
  const monumentsBefore = store.monuments();
  for (const tile of store.tiles()) store.setTileLevel(tile.tile_id, 4);
  const engine = new GodEngine(store, () => T0, 2, 'versus', 'streamer');
  const step = engine.next()!;
  const stakes = step.map!.targets!.map((t) => t.tile);
  const shown = engine.apply(step, resultFor(step.setup!, 'god')).display;
  assert.deepEqual(shown.map.changes!.map((c) => c.tile).sort(), [...stakes].sort());
  assert.ok(shown.map.changes!.every((c) => c.to === null && c.scorched));
  assert.match(shown.subtitle, /every Monument 15%/);

  for (const guild of ['red', 'green', 'blue'] as const) assert.equal(store.ownedTiles(guild), 4, `${guild} lost one tile`);
  for (const id of stakes) {
    const tile = store.tiles().find((t) => t.tile_id === id)!;
    assert.deepEqual([tile.owner_guild_id, tile.scorched, tile.level], [null, 1, 2]);
  }
  const monuments = store.monuments();
  for (const guild of ['red', 'green', 'blue'] as const) {
    assert.ok(Math.abs(monuments[guild] - monumentsBefore[guild] * 0.85) < 1e-6, `${guild}'s Monument lost 15%`);
  }
  assert.ok(monumentsBefore.red - monuments.red > 100);
  assert.equal(store.tiles().filter((t) => t.is_city === 1 && t.owner_guild_id !== null).length, 3, 'cities are never lost');
  store.close();
});

test('Streamer vs Chat: if chat wins, everyone gets XP and the hardest-hitting guild a tile level', () => {
  const store = setupStore(4);
  const xpBefore = new Map(store.recentlyActive(0).map((u) => [u.user_id, u.xp]));
  const monumentsBefore = store.monuments();
  const engine = new GodEngine(store, () => T0, 2, 'versus', 'streamer');
  const step = engine.next()!;
  assert.match(engine.apply(step, resultFor(step.setup!, 'chat')).display.title, /is defeated/);

  for (const user of store.recentlyActive(0)) {
    assert.equal(user.xp - xpBefore.get(user.user_id)!, config.god.winXp);
  }
  const development = (['red', 'green', 'blue'] as const).map((guild) => store.development(guild));
  assert.equal(development.reduce((a, b) => a + b, 0), 1, 'exactly one guild gained one level');
  assert.deepEqual(store.monuments(), monumentsBefore, 'no Monument was touched');
  assert.equal(engine.closing().title, 'streamer 0 : 1 Chat');
  store.close();
});

test('with enough wins against chat, the god wins the season', (t) => {
  const needed = config.god.winsToWinSeason;
  config.god.winsToWinSeason = 2;
  t.after(() => {
    config.god.winsToWinSeason = needed;
  });
  const store = setupStore(4);
  store.addMonument('red', 500);

  let engine = new GodEngine(store, () => T0, 3, 'wrath', 'streamer');
  let step = engine.next()!;
  engine.apply(step, resultFor(step.setup!, 'god'));
  assert.equal(engine.seasonWins, null);
  assert.equal(store.currentSeasonId(T0), 1, 'one win is not enough');

  engine = new GodEngine(store, () => T0, 4, 'wrath', 'streamer');
  step = engine.next()!;
  engine.apply(step, resultFor(step.setup!, 'god'));
  assert.equal(engine.seasonWins, 2);
  assert.deepEqual(store.lastSeason(), { season_id: 1, winner_guild_id: 'god' });
  assert.equal(store.currentSeasonId(T0), 2);
  assert.equal(engine.closing().title, 'streamer wins the season');
  // The new season starts fresh: land dealt, Monuments at zero, and the god's season score too.
  assert.deepEqual((['red', 'green', 'blue'] as const).map((g) => store.ownedTiles(g)), [5, 5, 5]);
  assert.deepEqual(Object.values(store.monuments()), [0, 0, 0]);
  assert.equal(store.godRecord(2).seasonWins, 0);
  assert.equal(store.godRecord(2).lifetimeWins, 2);
  assert.ok(store.recentlyActive(0).every((u) => u.seasons_won === 0), 'no guild won it');
  store.close();
});

test('the god looks like the broadcaster once they have written in chat', () => {
  const store = setupStore(2);
  store.recordMessage({
    type: 'chat',
    channel: 'test',
    userId: '1',
    login: 'streamer',
    displayName: 'TheStreamer',
    color: '#9146FF',
    badges: [{ name: 'broadcaster', version: '1' }],
    isBroadcaster: true,
    isModerator: false,
    text: 'hello Kappa',
    emoteIds: ['25'],
    sentAt: T0,
  });
  assert.deepEqual(store.godIdentity('fallback'), { name: 'TheStreamer', color: '#9146FF', emote: 'twitch:25' });
  const god = new GodEngine(store, () => T0, 1, 'wrath', 'fallback').next()!.setup!.fighters[0]!;
  assert.deepEqual([god.name, god.color, god.emote], ['TheStreamer', '#9146FF', 'twitch:25']);
  assert.equal(god.image, null, 'no picture was uploaded yet');

  // An uploaded picture takes the emote's place on the god.
  store.setGodPicture({ mime: 'image/png', data: Buffer.from('89504e470d0a1a0a', 'hex') });
  const withPicture = new GodEngine(store, () => T0, 1, 'wrath', 'fallback').next()!.setup!.fighters[0]!;
  assert.match(withPicture.image!, /^\/api\/god\/picture\?v=\d+$/);
  store.setGodPicture(null);
  assert.equal(store.godPictureUrl(), null);
  assert.equal(store.getUser('1'), null, 'the broadcaster is still not a player');
  store.close();
});

test('the god wins when it is still standing at the time limit', () => {
  const result = new Battle({
    seed: 1,
    durationMs: 3_000,
    sizeBalance: false,
    timeLimitWinner: 'god',
    sides: [
      { id: 'god', damageBonus: 0, healthBonus: 0 },
      { id: 'red', team: 'chat', damageBonus: 0, healthBonus: 0 },
    ],
    fighters: [
      // Far too much health to lose in three seconds, and no damage: neither side can finish the other.
      { id: 'god', name: 'God', color: null, side: 'god', level: 0, health: 1_000_000, damage: 0, radius: 50 },
      ...Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, name: '', color: null, side: 'red', level: 0 })),
    ],
  }).run();
  assert.deepEqual([result.winner, result.endedBy], ['god', 'time']);
});
