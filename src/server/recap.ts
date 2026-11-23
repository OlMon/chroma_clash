import { config, type GuildId } from '../config.ts';
import type { SeasonRecord } from '../db/store.ts';
import { guildName, translator } from '../i18n.ts';

/** One line of the recap: what it is, who or what, and in which color. */
export interface RecapRow {
  label: string;
  value: string;
  color: string | null;
}

/**
 * The recap of a season that just ended, for the overlay: its winner, then
 * its best chatters, its best Pachinko run, the god's score and how many
 * played. The overlay shows the rows one after another, `stepMs` apart, and
 * the winner's Monument beside them when a guild won.
 */
export interface RecapMessage {
  type: 'announce';
  title: string;
  subtitle: string;
  recap: { rows: RecapRow[]; stepMs: number; winner: GuildId | 'god' | null; design: number | null; color: string };
  holdMs: number;
}

export function recapMessage(season: SeasonRecord, god: { name: string; color: string }, lang: string): RecapMessage | null {
  const summary = season.summary;
  if (!summary) return null;
  const t = translator(lang);
  const guildOf = (id: GuildId) => config.guilds.list.find((g) => g.id === id)!;
  const rows: RecapRow[] = [];
  const winner = season.winner;

  if (winner === 'god') {
    rows.push({ label: t('server.recap.winner'), value: t('server.recap.godWon', { god: god.name, wins: season.godWins }), color: god.color });
  } else if (winner) {
    const share = Math.min(100, Math.floor((summary.guilds[winner].monument / summary.monumentGoal) * 100));
    const value =
      summary.endedBy === 'monument'
        ? t('server.recap.monumentDone', { guild: guildName(lang, winner) })
        : t('server.recap.monumentAt', { guild: guildName(lang, winner), percent: share });
    rows.push({ label: t('server.recap.winner'), value, color: guildOf(winner).color });
  }
  const who = (label: string, value: string | null) => {
    if (value) rows.push({ label, value, color: null });
  };
  who(t('server.recap.topKiller'), summary.topKiller && `${summary.topKiller.displayName} · ${t('server.stats.kills', { count: summary.topKiller.kills })}`);
  who(t('server.recap.highestLevel'), summary.topLevel && t('server.stats.level', { name: summary.topLevel.displayName, level: summary.topLevel.level }));
  who(t('server.recap.clashWins'), summary.champion && t('server.recap.wins', { name: summary.champion.displayName, count: summary.champion.wins }));
  who(t('server.recap.pachinko'), summary.pachinko ? t('server.recap.points', { name: summary.pachinko.displayName, count: summary.pachinko.points }) : null);
  who(t('server.recap.duelWins'), summary.duel ? t('server.recap.wins', { name: summary.duel.displayName, count: summary.duel.wins }) : null);
  rows.push({ label: t('server.stats.godSeason', { god: god.name }), value: `${season.godWins} : ${season.godLosses}`, color: god.color });
  rows.push({ label: t('server.stats.players'), value: String(summary.players), color: null });

  const { stepMs, holdMs } = config.recap;
  return {
    type: 'announce',
    title: t('server.recap.title', { season: season.id }),
    subtitle: '',
    recap: {
      rows,
      stepMs,
      winner,
      design: winner && winner !== 'god' ? (summary.guilds[winner].design ?? null) : null,
      color: winner === 'god' ? god.color : winner ? guildOf(winner).color : '#FFFFFF',
    },
    holdMs: rows.length * stepMs + holdMs,
  };
}
