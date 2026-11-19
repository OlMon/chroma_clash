import { statSync } from 'node:fs';

/** What an overlay page reports about itself every few seconds. */
export interface OverlayReport {
  /** Average time to draw a frame, in milliseconds. */
  frameMs: number;
  /** The slowest frame of the period, in milliseconds. */
  slowMs: number;
  /** Frames drawn per second; low while nothing moves, which is fine. */
  fps: number;
  width: number;
  height: number;
  theme: string;
  /** Whether the page draws with the graphics card; false means software drawing (slow); null when it cannot tell. */
  gpu: boolean | null;
}

export interface OverlayInfo extends Partial<OverlayReport> {
  connectedAt: number;
  reportedAt: number | null;
}

const finite = (value: unknown, max: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null;

/** Checks a report sent by an overlay page; anything malformed is dropped. */
export function readOverlayReport(message: Record<string, unknown>): OverlayReport | null {
  const frameMs = finite(message.frameMs, 10_000);
  const slowMs = finite(message.slowMs, 60_000);
  const fps = finite(message.fps, 1_000);
  const width = finite(message.width, 20_000);
  const height = finite(message.height, 20_000);
  const theme = typeof message.theme === 'string' ? message.theme.slice(0, 40) : '';
  const gpu = typeof message.gpu === 'boolean' ? message.gpu : null;
  if (frameMs === null || slowMs === null || fps === null || width === null || height === null) return null;
  return { frameMs, slowMs, fps, width, height, theme, gpu };
}

/** The size of a database and its write-ahead log on disk; null for one in memory. */
export function databaseSize(path: string | undefined): { path: string; bytes: number; walBytes: number } | null {
  if (!path || path === ':memory:') return null;
  const size = (file: string): number => {
    try {
      return statSync(file).size;
    } catch {
      return 0;
    }
  };
  return { path, bytes: size(path), walBytes: size(`${path}-wal`) };
}
