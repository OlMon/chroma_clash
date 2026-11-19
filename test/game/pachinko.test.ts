import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../../src/config.ts';
import { dropPath, fallMs, playPachinko } from '../../src/game/pachinko.ts';
import { createRng } from '../../src/util/rng.ts';

test('a ball bounces once per row and lands in the slot its bounces lead to', () => {
  const rng = createRng(1);
  const landed = new Array(config.pachinko.rows + 1).fill(0);
  for (let i = 0; i < 4000; i++) {
    const { path, slot } = dropPath(rng);
    assert.equal(path.length, config.pachinko.rows);
    assert.equal(slot, path.filter((step) => step === 1).length);
    landed[slot]++;
  }
  // Like a real board: the middle is common, the edges are rare.
  const middle = config.pachinko.rows / 2;
  assert.ok(landed[middle] > 5 * landed[0] && landed[middle] > 5 * landed[config.pachinko.rows]);
});

test('every guild drops as many balls; a small guild drops some players again', () => {
  const game = playPachinko(
    [
      { team: 'red', players: ['a', 'b', 'c', 'd'] },
      { team: 'green', players: ['e', 'f'] },
      { team: 'blue', players: [] },
    ],
    createRng(2),
  );
  assert.deepEqual(game.boards.map((b) => b.team), ['red', 'green'], 'a guild nobody plays for has no board');
  const balls = Math.max(4, config.pachinko.minBalls);
  for (const board of game.boards) {
    assert.equal(board.drops.length, balls);
    assert.equal(board.total, board.drops.reduce((sum, d) => sum + d.points, 0));
    for (const drop of board.drops) assert.equal(drop.points, config.pachinko.slots[drop.slot]);
  }
  assert.deepEqual(game.boards[1]!.drops.map((d) => d.player), Array.from({ length: balls }, (_, i) => (i % 2 ? 'f' : 'e')));
  // One ball at a time, the boards taking turns, and the whole game about as long as a fight.
  const times = game.boards.flatMap((b) => b.drops.map((d) => d.at)).sort((a, b) => a - b);
  assert.equal(new Set(times).size, times.length, 'never two balls at once');
  assert.equal(game.boards[0]!.drops[0]!.at, 0);
  assert.ok(game.boards[1]!.drops[0]!.at > 0, 'the second board drops after the first');
  assert.equal(game.durationMs, times[times.length - 1]! + fallMs());
  assert.ok(game.durationMs >= 50_000 && game.durationMs <= 90_000, `${game.durationMs} ms`);
});

test('the highest total wins; a tie goes to more balls in the best slots', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const game = playPachinko(
      ['red', 'green', 'blue'].map((team) => ({ team, players: ['x', 'y', 'z'] })),
      createRng(seed),
    );
    const ranked = [...game.boards].sort((a, b) => b.total - a.total || b.jackpots - a.jackpots);
    const top = ranked[0]!;
    const winner = game.boards.find((b) => b.team === game.winner)!;
    assert.equal(winner.total, top.total, `seed ${seed}`);
    assert.equal(winner.jackpots, top.jackpots, `seed ${seed}`);
  }
});
