// Renders every preview scene in every overlay theme to PNGs, for a visual
// check before a release. See README.md.
//
//   npm run preview                         all scenes, all themes
//   npm run preview -- --scene fire         one scene (repeat, or comma-separate, for more)
//   npm run preview -- --theme pixel        one theme
//   npm run preview -- --lang de            in another language
//   CHROMIUM=/path/to/chrome npm run preview
//
// Writes tools/preview/out/<theme>/<scene>-<at>ms.png, a contact sheet per
// theme (out/<theme>.html) and out/index.html with all themes side by side.
// Another language goes to out/<lang>/ in the same layout.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { delimiter, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { generateScenes, type Scene } from './scenes.ts';
import { startServer } from './serve.ts';

const HERE = import.meta.dirname;
const ROOT = resolve(HERE, '../..');
const OUT = join(HERE, 'out');
/** Where this run's pictures and sheets go: OUT for English, OUT/<lang> for another language. */
let target = OUT;
/** Virtual time each page gets before the picture: it waits 1.5 s for the replay, then for emotes and fonts. */
const BUDGET_MS = 6000;

function fail(message: string): never {
  console.error(`preview: ${message}`);
  process.exit(1);
}

function findChromium(): string {
  const fromEnv = process.env.CHROMIUM;
  if (fromEnv) {
    if (!existsSync(fromEnv)) fail(`CHROMIUM is set to ${fromEnv}, but there is no such file.`);
    return fromEnv;
  }
  const names = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome'];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of names) {
      const path = join(dir, name);
      if (dir && existsSync(path)) return path;
    }
  }
  for (const path of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']) {
    if (existsSync(path)) return path;
  }
  fail(`no Chromium or Chrome found (looked for ${names.join(', ')} on the PATH).\n` +
    'Install Chromium, or point the CHROMIUM environment variable at a Chrome or Chromium binary.');
}

/** Theme ids: every folder in overlay/themes with a theme.json. */
function findThemes(): string[] {
  const dir = join(ROOT, 'overlay', 'themes');
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory() && existsSync(join(dir, name, 'theme.json')))
    .sort((a, b) => (a === 'plain' ? -1 : b === 'plain' ? 1 : a.localeCompare(b)));
}

/** `--scene a --scene b,c` → ['a', 'b', 'c'], checked against what exists. */
function pickList(given: string[] | undefined, all: string[], what: string): string[] {
  if (!given?.length) return all;
  const wanted = given.flatMap((g) => g.split(',')).map((g) => g.trim()).filter(Boolean);
  const unknown = wanted.filter((w) => !all.includes(w));
  if (unknown.length) fail(`unknown ${what} ${unknown.join(', ')}. Known: ${all.join(', ')}.`);
  return all.filter((a) => wanted.includes(a));
}

interface Shot {
  scene: string;
  theme: string;
  at: number;
  file: string;
}

interface ShotResult {
  ok: boolean;
  problems: string[];
}

/**
 * One headless Chromium per picture: virtual time makes the moment the same on every run.
 * The background stays transparent, as OBS sees the overlay.
 */
function takeShot(chromium: string, profile: string, url: string, file: string): Promise<ShotResult> {
  return new Promise((done) => {
    const args = [
      '--headless', '--no-sandbox', '--hide-scrollbars', '--mute-audio', '--no-first-run', '--disable-gpu-sandbox',
      `--user-data-dir=${profile}`, '--window-size=1920,1080', '--default-background-color=00000000', `--virtual-time-budget=${BUDGET_MS}`,
      '--enable-logging=stderr', '--v=0', `--screenshot=${file}`, url,
    ];
    const child = spawn(chromium, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', (error) => { clearTimeout(timer); done({ ok: false, problems: [`could not start ${chromium}: ${error.message}`] }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // The page's console, as Chromium logs it: "...:INFO:CONSOLE:12] "message", source: url (line)".
      const consoleLines = stderr.split('\n')
        .map((line) => /:CONSOLE(?::\d+)?\] "(.*)", source: (\S*)/.exec(line))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => `${m[1]}${m[2] ? ` (${m[2].split('/').pop()})` : ''}`);
      const ready = consoleLines.some((line) => line.startsWith('preview: ready'));
      // Chromium's hint about getImageData shows on every pixel-theme page; it is not a fault.
      const problems = consoleLines.filter((line) => !line.startsWith('preview: ready') && !line.startsWith('Canvas2D: Multiple readback'));
      if (!ready) problems.push('the page never reported ready (raise BUDGET_MS in render.ts?)');
      if (!existsSync(file)) problems.push(`no picture written (chromium exited with ${code})`);
      done({ ok: ready && existsSync(file) && !problems.some((p) => p.startsWith('Uncaught')), problems });
    });
  });
}

function contactSheet(theme: string, scenes: Scene[], themes: string[]): string {
  const cells = scenes.flatMap((scene) => scene.moments.map((at) => {
    const src = `${theme}/${scene.name}-${at}ms.png`;
    return existsSync(join(target, src))
      ? `<figure><a href="${src}"><img src="${src}" loading="lazy"></a><figcaption>${scene.name} · ${at} ms</figcaption></figure>`
      : '';
  }));
  const nav = themes.map((t) => (t === theme ? `<b>${t}</b>` : `<a href="${t}.html">${t}</a>`)).join(' · ');
  return sheetPage(`Preview · ${theme}`, `<nav>${nav} · <a href="index.html">all themes</a></nav><main class="grid">${cells.join('')}</main>`);
}

function indexSheet(scenes: Scene[], themes: string[]): string {
  const head = `<tr><th></th>${themes.map((t) => `<th><a href="${t}.html">${t}</a></th>`).join('')}</tr>`;
  const rows = scenes.flatMap((scene) => scene.moments.map((at) =>
    `<tr><th>${scene.name}<br><small>${at} ms</small></th>${themes.map((t) => {
      const src = `${t}/${scene.name}-${at}ms.png`;
      return `<td>${existsSync(join(target, src)) ? `<a href="${src}"><img src="${src}" loading="lazy"></a>` : ''}</td>`;
    }).join('')}</tr>`));
  return sheetPage('Preview · all themes', `<table>${head}${rows.join('')}</table>`);
}

function sheetPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
body{margin:16px;background:#2a2a2e;color:#eee;font:14px system-ui,sans-serif}a{color:#9cf}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(560px,1fr));gap:16px;margin-top:12px}
figure{margin:0}img{width:100%;display:block;background:repeating-conic-gradient(#555 0 25%,#444 0 50%) 0 0/24px 24px}
figcaption{padding:4px 0}table{border-collapse:collapse;width:100%}td,th{padding:4px;vertical-align:top;text-align:left}
</style></head><body><h1>${title}</h1>${body}</body></html>`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      scene: { type: 'string', multiple: true },
      theme: { type: 'string', multiple: true },
      lang: { type: 'string', default: 'en' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log('Usage: npm run preview [-- --scene <name>[,<name>…]] [--theme <id>[,<id>…]] [--lang <id>]\nSee tools/preview/README.md.');
    return;
  }
  const chromium = findChromium();
  // Chromium must start: a wrong CHROMIUM path or a broken install fails here, once.
  const version = spawnSync(chromium, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) fail(`${chromium} --version failed: ${(version.stderr || version.error?.message || '').trim()}`);

  const lang = values.lang ?? 'en';
  if (!existsSync(join(ROOT, 'lang', `${lang}.json`))) fail(`no language file lang/${lang}.json.`);
  // English keeps the usual place; another language gets a folder of its own, so neither overwrites the other.
  target = lang === 'en' ? OUT : join(OUT, lang);

  const started = performance.now();
  const allScenes = generateScenes(join(target, 'pages'), lang);
  const allThemes = findThemes();
  const sceneNames = pickList(values.scene, allScenes.map((s) => s.name), 'scene');
  const scenes = allScenes.filter((s) => sceneNames.includes(s.name));
  const themes = pickList(values.theme, allThemes, 'theme');

  const server = await startServer(ROOT, join(target, 'pages'), join(OUT, 'emotes'));
  const shots: Shot[] = [];
  for (const theme of themes) {
    mkdirSync(join(target, theme), { recursive: true });
    for (const scene of scenes) {
      for (const at of scene.moments) shots.push({ scene: scene.name, theme, at, file: join(target, theme, `${scene.name}-${at}ms.png`) });
    }
  }
  console.log(`${version.stdout.trim()}: ${scenes.length} scenes × ${themes.length} themes (${themes.join(', ')}) in ${lang} = ${shots.length} pictures`);

  const workers = Math.max(1, Math.min(6, Math.floor(availableParallelism() / 2)));
  const profiles = join(OUT, '.chromium');
  const failures: string[] = [];
  let next = 0;
  let finished = 0;
  try {
    await Promise.all(Array.from({ length: workers }, async (_, w) => {
      const profile = join(profiles, String(w));
      while (next < shots.length) {
        const shot = shots[next++]!;
        rmSync(shot.file, { force: true });
        const url = `http://127.0.0.1:${server.port}/overlay/_preview/${shot.scene}.html?theme=${encodeURIComponent(shot.theme)}&at=${shot.at}&lang=${encodeURIComponent(lang)}`;
        const result = await takeShot(chromium, profile, url, shot.file);
        finished++;
        const name = relative(target, shot.file);
        if (!result.ok) failures.push(name);
        const note = result.problems.length ? `\n    ${result.problems.join('\n    ')}` : '';
        console.log(`[${String(finished).padStart(String(shots.length).length)}/${shots.length}] ${result.ok ? 'ok  ' : 'FAIL'} ${name}${note}`);
      }
    }));
  } finally {
    await server.close();
    rmSync(profiles, { recursive: true, force: true });
  }

  // The sheets show every picture on disk, so a partial run still sits next to the earlier ones.
  for (const theme of allThemes) {
    if (existsSync(join(target, theme))) writeFileSync(join(target, `${theme}.html`), contactSheet(theme, allScenes, allThemes));
  }
  writeFileSync(join(target, 'index.html'), indexSheet(allScenes, allThemes.filter((t) => existsSync(join(target, t)))));

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`\n${shots.length - failures.length} of ${shots.length} pictures in ${seconds} s → ${relative(process.cwd(), target) || '.'}/`);
  console.log(`contact sheets: ${relative(process.cwd(), join(target, 'index.html'))}, ${themes.map((t) => relative(process.cwd(), join(target, `${t}.html`))).join(', ')}`);
  if (failures.length) fail(`${failures.length} picture(s) had errors: ${failures.join(', ')}`);
}

await main();
