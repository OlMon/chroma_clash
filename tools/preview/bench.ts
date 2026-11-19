// Frame-time benchmark: how long the overlay takes to draw one battle frame in
// each theme, measured in headless Chromium over the DevTools protocol.
//
//   node tools/preview/bench.ts                       the fire scene at 1500 ms, every theme
//   node tools/preview/bench.ts --scene classes --at 250 --theme pixel --frames 120
//
// Numbers are for comparing themes and changes on one machine; headless
// Chromium draws on the CPU, so they run higher than in OBS.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { generateScenes } from './scenes.ts';
import { startServer } from './serve.ts';

const HERE = import.meta.dirname;
const ROOT = resolve(HERE, '../..');
const OUT = join(HERE, 'out');
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

const { values } = parseArgs({
  options: {
    scene: { type: 'string', default: 'fire' },
    at: { type: 'string', default: '1500' },
    theme: { type: 'string', multiple: true },
    frames: { type: 'string', default: '60' },
  },
});

function findChromium(): string {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']) {
      if (dir && existsSync(join(dir, name))) return join(dir, name);
    }
  }
  console.error('bench: no Chromium found; set the CHROMIUM environment variable.');
  process.exit(1);
}

const themesDir = join(ROOT, 'overlay', 'themes');
const themes = values.theme?.length
  ? values.theme.flatMap((t) => t.split(','))
  : readdirSync(themesDir).filter((t) => statSync(join(themesDir, t)).isDirectory() && existsSync(join(themesDir, t, 'theme.json')));

const scenes = generateScenes(join(OUT, 'pages'));
if (!scenes.some((s) => s.name === values.scene)) {
  console.error(`bench: unknown scene ${values.scene}. Known: ${scenes.map((s) => s.name).join(', ')}`);
  process.exit(1);
}
const server = await startServer(ROOT, join(OUT, 'pages'), join(OUT, 'emotes'));
const profile = mkdtempSync(join(tmpdir(), 'chroma-bench-'));
const browser = spawn(findChromium(), [
  '--headless', '--no-sandbox', '--hide-scrollbars', '--window-size=1920,1080',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

try {
  // Chromium writes the port it picked into the profile folder.
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await wait(100);
  const debugPort = readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target in Chromium');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done) => ws.addEventListener('open', done));
  let id = 0;
  const pending = new Map<number, (result: any) => void>();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
  });
  const send = (method: string, params: object = {}) => new Promise<any>((done) => {
    pending.set(++id, done);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression: string) => (await send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value;

  const at = Number(values.at);
  const frames = Number(values.frames);
  console.log(`${values.scene} at ${at} ms, ${frames} frames each`);
  for (const theme of themes) {
    await send('Page.navigate', { url: `http://127.0.0.1:${server.port}/overlay/_preview/${values.scene}.html?theme=${encodeURIComponent(theme)}&at=${at}` });
    for (let i = 0; i < 150 && (await evaluate('document.title')) !== 'ready'; i++) await wait(100);
    // A few frames to warm up, then the timed ones; getImageData waits for the canvas to finish drawing.
    const draw = `(battle ? frame(() => renderBattle(performance.now() + ${at})) : drawPanel())`;
    const ms = await evaluate(`(() => {
      for (let i = 0; i < 5; i++) ${draw};
      const t0 = performance.now();
      for (let i = 0; i < ${frames}; i++) { ${draw}; screen.getImageData(0, 0, 1, 1); }
      return ((performance.now() - t0) / ${frames}).toFixed(2);
    })()`);
    console.log(`${theme.padEnd(10)} ${ms ?? '?'} ms per frame`);
  }
  ws.close();
} finally {
  browser.kill();
  await server.close();
  await wait(200);
  rmSync(profile, { recursive: true, force: true });
}
