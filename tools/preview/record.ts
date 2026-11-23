// Records the website's clips from the real overlay: starts the game with the
// simulated chat, lets chat warm up, starts a fight, records the overlay in a
// headless Chromium through the DevTools screencast, and makes an MP4 and a
// poster picture with ffmpeg.
//
//   node tools/preview/record.ts [--clip battle,streamer-vs-chat,brawl,duel] [--out website/media]
//
// battle  a War battle in the Dark Fantasy Comic theme
// streamer-vs-chat  Streamer vs Chat in the Pixel RPG theme
// brawl   the Arena's brawl in the Dark Fantasy Comic theme, the god joining
// duel    a duel in the Pixel RPG theme: the VS screen, then the fight

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');
const { values } = parseArgs({
  options: {
    clip: { type: 'string', default: 'battle,streamer-vs-chat,brawl,duel' },
    out: { type: 'string', default: join(ROOT, 'website', 'media') },
  },
});
function findChromium(): string {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']) {
      if (dir && existsSync(join(dir, name))) return join(dir, name);
    }
  }
  console.error('record: no Chromium found; set the CHROMIUM environment variable.');
  process.exit(1);
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** The page's background in the clips: dark, like a stream behind the overlay. */
const BACKDROP = '#15171d';

interface Clip {
  theme: string;
  /** Simulated chatters, and how long chat runs (fast) before the fight so enough are active. */
  chatters: number;
  /** Starts the fight; `post` sends to the game's API. Resolves once it is on screen. */
  start(post: (path: string, body: object) => Promise<void>, page: Page): Promise<void>;
  /** Seconds to record from then, and what happens during them. */
  seconds: number;
  during?(post: (path: string, body: object) => Promise<void>, at: number): Promise<void> | void;
}

interface Page {
  evaluate(expression: string): Promise<unknown>;
}

async function until(check: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await wait(100);
  }
  throw new Error('timed out');
}

const CLIPS: Record<string, Clip> = {
  battle: {
    theme: 'comic',
    chatters: 90,
    seconds: 17,
    async start(post, page) {
      await post('/api/war/start', {});
      // The War's map is shown first; the clip starts as the battle comes in.
      await until(async () => (await page.evaluate('Boolean(battle && battle.latest)')) === true, 90_000);
    },
  },
  'streamer-vs-chat': {
    theme: 'pixel',
    chatters: 90,
    seconds: 18,
    async start(post, page) {
      await post('/api/god/start', { kind: 'versus' });
      await until(async () => (await page.evaluate('Boolean(battle && battle.latest)')) === true, 90_000);
      await wait(2_500);
    },
  },
  brawl: {
    theme: 'comic',
    chatters: 40,
    seconds: 18,
    async start(post, page) {
      await post('/api/brawl', { fighters: 9 });
      await post('/api/brawl', { active: true });
      await until(async () => (await page.evaluate('Boolean(brawlShow && brawlShow.fighters.size >= 8)')) === true, 60_000);
      await wait(4_000);
    },
    async during(post, at) {
      if (at === 6) await post('/api/brawl', { join: 'god' });
    },
  },
  duel: {
    theme: 'pixel',
    chatters: 40,
    seconds: 24,
    async start(post, page) {
      await post('/api/duel/start', { a: null, b: null });
      // From the VS screen on: the two slide in and "VS" slams down.
      await until(async () => (await page.evaluate('Boolean(announcement && announcement.lineup && announcement.lineup.duel)')) === true, 30_000);
    },
  },
};

async function record(name: string, clip: Clip, outDir: string): Promise<void> {
  const port = 4800 + Math.floor(Math.random() * 100);
  const data = mkdtempSync(join(tmpdir(), 'chroma-record-'));
  const profile = mkdtempSync(join(tmpdir(), 'chroma-record-browser-'));
  const frames = mkdtempSync(join(tmpdir(), 'chroma-record-frames-'));
  let game: ChildProcess | null = null;
  let browser: ChildProcess | null = null;
  try {
    // Chat runs fast for a while, so the fight has plenty of active chatters.
    game = spawn(process.execPath, [join(ROOT, 'src', 'main.ts'), '--sim', '--channel', 'thestreamer', '--data', data, '--port', String(port), '--no-open', '--chatters', String(clip.chatters), '--speed', '40'], { stdio: 'ignore' });
    const base = `http://127.0.0.1:${port}`;
    await until(async () => (await fetch(`${base}/api/state`).catch(() => null))?.ok === true);
    const post = async (path: string, body: object) => {
      const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
    };
    await post('/api/display', { theme: clip.theme, language: 'en' });
    console.log(`  ${name}: chat warming up`);
    await wait(25_000);

    browser = spawn(findChromium(), ['--headless', '--no-sandbox', '--hide-scrollbars', '--window-size=1920,1080', '--force-device-scale-factor=1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    const portFile = join(profile, 'DevToolsActivePort');
    await until(async () => existsSync(portFile));
    const debugPort = readFileSync(portFile, 'utf8').split('\n')[0];
    const target = ((await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[]).find((t) => t.type === 'page')!;
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((done) => ws.addEventListener('open', done));
    let id = 0;
    const pending = new Map<number, (result: any) => void>();
    const shots: { data: string; at: number }[] = [];
    let recording = false;
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Page.screencastFrame') {
        if (recording) shots.push({ data: message.params.data, at: message.params.metadata.timestamp });
        ws.send(JSON.stringify({ id: ++id, method: 'Page.screencastFrameAck', params: { sessionId: message.params.sessionId } }));
        return;
      }
      pending.get(message.id)?.(message.result);
      pending.delete(message.id);
    });
    const send = (method: string, params: object = {}) =>
      new Promise<any>((done) => {
        pending.set(++id, done);
        ws.send(JSON.stringify({ id, method, params }));
      });
    const page: Page = { evaluate: async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value };
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.background = '${BACKDROP}'; document.body.style.background = '${BACKDROP}'; });`,
    });
    await send('Page.navigate', { url: `${base}/overlay/` });
    await wait(3_000);
    await send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });

    console.log(`  ${name}: starting the fight`);
    await clip.start(post, page);
    recording = true;
    for (let second = 0; second < clip.seconds; second++) {
      await clip.during?.(post, second);
      await wait(1_000);
    }
    recording = false;
    await send('Page.stopScreencast');
    ws.close();
    if (shots.length < 10) throw new Error(`only ${shots.length} frames were recorded`);

    // Each frame lasts until the next; ffmpeg turns that into an even 30 frames a second.
    const list: string[] = [];
    shots.forEach((shot, i) => {
      const file = join(frames, `${String(i).padStart(5, '0')}.jpg`);
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      const next = shots[i + 1];
      list.push(`file '${file}'`, `duration ${next ? Math.max(0.001, next.at - shot.at).toFixed(4) : '0.0333'}`);
    });
    list.push(`file '${join(frames, `${String(shots.length - 1).padStart(5, '0')}.jpg`)}'`);
    const listFile = join(frames, 'list.txt');
    writeFileSync(listFile, list.join('\n'));
    const fps = shots.length / (shots.at(-1)!.at - shots[0]!.at);
    console.log(`  ${name}: ${shots.length} frames, ${fps.toFixed(1)} a second`);
    mkdirSync(outDir, { recursive: true });
    const mp4 = join(outDir, `${name}.mp4`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', 'scale=960:540:flags=lanczos,fps=30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
    // The poster: a frame from the middle.
    const middle = join(frames, `${String(Math.floor(shots.length * 0.45)).padStart(5, '0')}.jpg`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', middle, '-vf', 'scale=960:540:flags=lanczos', '-q:v', '3', join(outDir, `${name}.jpg`)]);
    console.log(`  ${name}: ${mp4}`);
  } finally {
    browser?.kill();
    game?.kill();
    await wait(300);
    for (const folder of [data, profile, frames]) rmSync(folder, { recursive: true, force: true });
  }
}

for (const name of values.clip.split(',')) {
  const clip = CLIPS[name];
  if (!clip) throw new Error(`unknown clip ${name}; known: ${Object.keys(CLIPS).join(', ')}`);
  console.log(`recording ${name}`);
  await record(name, clip, resolve(values.out));
}
