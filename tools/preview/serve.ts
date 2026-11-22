// The preview server: the repo's overlay files, plus the scene pages under
// /overlay/_preview/, and Twitch emotes the way the game's server proxies them
// (cached on disk, so a full run fetches each emote once).
//
// Run alone to look at scenes in a browser:
//   node tools/preview/serve.ts [port]   (default 4790; pages from tools/preview/out/pages)
//   http://127.0.0.1:4790/overlay/_preview/fire.html?theme=comic&at=1500

import { createServer, type Server } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export interface PreviewServer {
  port: number;
  close(): Promise<void>;
}

/** Serves `root` (the repo), `pagesDir` under /overlay/_preview/, and emotes cached in `emoteCache`. */
export function startServer(root: string, pagesDir: string, emoteCache: string, port = 0): Promise<PreviewServer> {
  const inside = (base: string, path: string) => {
    const file = normalize(join(base, path));
    return file === base || file.startsWith(base + sep) ? file : null;
  };
  const server: Server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    // A folder serves its index.html.
    const url = path.endsWith('/') ? `${path}index.html` : path;
    const emote = /^\/emotes\/twitch\/(\w+)$/.exec(url);
    if (emote) {
      const cached = join(emoteCache, `${emote[1]}.png`);
      try {
        const body = await readFile(cached);
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(body);
        return;
      } catch { /* not cached yet */ }
      try {
        const r = await fetch(`https://static-cdn.jtvnw.net/emoticons/v2/${emote[1]}/static/dark/2.0`);
        if (!r.ok) throw new Error(String(r.status));
        const body = Buffer.from(await r.arrayBuffer());
        await mkdir(emoteCache, { recursive: true });
        await writeFile(cached, body);
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
      return;
    }
    const file = url.startsWith('/overlay/_preview/')
      ? inside(pagesDir, url.slice('/overlay/_preview/'.length))
      : inside(root, url);
    try {
      if (!file) throw new Error('outside');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      done({
        port: typeof address === 'object' && address ? address.port : port,
        close: () => new Promise<void>((closed) => { server.closeAllConnections(); server.close(() => closed()); }),
      });
    });
  });
}

if (import.meta.main) {
  const here = import.meta.dirname;
  const out = join(here, 'out');
  const { port } = await startServer(resolve(here, '../..'), join(out, 'pages'), join(out, 'emotes'), Number(process.argv[2] ?? 4790));
  console.log(`preview server on http://127.0.0.1:${port}/overlay/_preview/<scene>.html?theme=<id>&at=<ms>`);
}
