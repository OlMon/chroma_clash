/**
 * Shared by the balancing tools: a simulated channel full of active chatters,
 * and a battle set up as the battle runner would start it.
 */
import { config, type GuildId } from '../config.ts';
import { Store } from '../db/store.ts';
import type { BattleSetup } from '../game/battle.ts';
import { createRng } from '../util/rng.ts';

export const T0 = 1_800_000_000_000;
const COLORS: Record<GuildId, string> = { red: '#FF0000', green: '#00FF00', blue: '#0000FF' };

/** A channel with `perGuild` chatters in each guild, all active now, with a few minutes of ticks. */
export function channel(perGuild: number, seed: number): Store {
  const store = Store.open(':memory:');
  store.setManualChatters(perGuild * 3);
  store.startSession(T0 - 60 * 60_000);
  const rng = createRng(seed);
  let id = 1;
  for (const guild of ['red', 'green', 'blue'] as const) {
    for (let i = 0; i < perGuild; i++, id++) {
      // A few windows each, so the most active chatters differ.
      const windows = 1 + Math.floor(rng() * 6);
      for (let w = 0; w < windows; w++) {
        store.recordMessage({
          type: 'chat', channel: 'c', userId: String(id), login: `u${id}`, displayName: `U${id}`, color: COLORS[guild],
          badges: [], isBroadcaster: false, isModerator: false, text: 'hi', emoteIds: [],
          sentAt: T0 - w * config.ticks.windowMs - 1000,
        });
      }
    }
  }
  return store;
}

/** The setup as the battle runner would start it: with obstacles and the map banner's shorter arena. */
export function asRunner(setup: BattleSetup): BattleSetup {
  const teams = new Set(setup.sides.map((side) => side.team ?? side.id)).size;
  const arena = config.battle.arena;
  return {
    ...setup,
    obstacles: setup.obstacles ?? (setup.endless || teams > 3 ? 'changing' : 'fixed'),
    arena: setup.arena ?? { ...arena, height: arena.height - config.battle.bannerHeight },
  };
}

