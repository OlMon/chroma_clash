import { spawn } from 'node:child_process';

/** Opens a web address in the default browser. Best effort: a failure only prints the address. */
export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', `"${url}"`]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
      // cmd's `start` needs its quotes as written; Node would escape them.
      windowsVerbatimArguments: true,
    });
    child.on('error', () => console.log(`Open ${url} in your browser.`));
    child.unref();
  } catch {
    console.log(`Open ${url} in your browser.`);
  }
}
