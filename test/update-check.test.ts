import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appVersion, checkForUpdate, compareVersions } from '../src/update-check.ts';

const VERSION_URL = 'https://example.gitlab.io/chroma-clash/version.json';

/** A fetch that answers every request with this body and status. */
function answer(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as typeof fetch;
}

test('versions compare part by part, as numbers', () => {
  assert.equal(compareVersions('0.2.0', '0.1.0'), 1);
  assert.equal(compareVersions('0.1.0', '0.2.0'), -1);
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
});

test('a pre-release is older than its release', () => {
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0-beta.1'), -1);
  assert.equal(compareVersions('1.0.0+build.5', '1.0.0'), 0);
});

test('something that is not a version compares as nothing', () => {
  assert.equal(compareVersions('latest', '1.0.0'), null);
  assert.equal(compareVersions('1.0.0', ''), null);
});

test('the running version comes from package.json', () => {
  assert.notEqual(compareVersions(appVersion, '0.0.0'), null);
});

test('a newer version on the website is reported with its download page and notes', async () => {
  const body = JSON.stringify({ version: '0.2.0', url: 'https://example.gitlab.io/chroma-clash/', notes: ' Wars! ' });
  assert.deepEqual(await checkForUpdate('0.1.0', VERSION_URL, answer(body)), {
    latest: '0.2.0',
    url: 'https://example.gitlab.io/chroma-clash/',
    notes: 'Wars!',
  });
});

test('the same or an older version is no update', async () => {
  assert.equal(await checkForUpdate('0.2.0', VERSION_URL, answer('{"version":"0.2.0","url":"https://x.io/"}')), null);
  assert.equal(await checkForUpdate('0.2.0', VERSION_URL, answer('{"version":"0.1.9","url":"https://x.io/"}')), null);
  assert.equal(await checkForUpdate('1.0.0', VERSION_URL, answer('{"version":"1.0.0-rc.1"}')), null);
});

test('without a download address the website folder is linked; a relative one is resolved', async () => {
  assert.equal((await checkForUpdate('0.1.0', VERSION_URL, answer('{"version":"0.2.0"}')))?.url, 'https://example.gitlab.io/chroma-clash/');
  assert.equal(
    (await checkForUpdate('0.1.0', VERSION_URL, answer('{"version":"0.2.0","url":"download.html"}')))?.url,
    'https://example.gitlab.io/chroma-clash/download.html',
  );
});

test('a download address that is not http or https is refused', async () => {
  assert.equal(await checkForUpdate('0.1.0', VERSION_URL, answer('{"version":"0.2.0","url":"javascript:alert(1)"}')), null);
});

test('a network failure, a timeout or an error status means no update, never an exception', async () => {
  const failing = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  assert.equal(await checkForUpdate('0.1.0', VERSION_URL, failing), null);
  assert.equal(await checkForUpdate('0.1.0', VERSION_URL, answer('{"version":"9.0.0"}', 404)), null);

  // A server that never answers: the timeout aborts the request.
  const hanging = ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as typeof fetch;
  assert.equal(await checkForUpdate('0.1.0', VERSION_URL, hanging, 20), null);
});

test('malformed JSON, or JSON without a usable version, means no update', async () => {
  assert.equal(await checkForUpdate('0.1.0', VERSION_URL, answer('{ not json')), null);
  assert.equal(await checkForUpdate('0.1.0', VERSION_URL, answer('null')), null);
  assert.equal(await checkForUpdate('0.1.0', VERSION_URL, answer('"0.2.0"')), null);
  assert.equal(await checkForUpdate('0.1.0', VERSION_URL, answer('{"version":2}')), null);
  assert.equal(await checkForUpdate('0.1.0', VERSION_URL, answer('{"version":"soon"}')), null);
});

test('no address or a bad one: nothing is fetched', async () => {
  let calls = 0;
  const counting = (async () => {
    calls++;
    return new Response('{"version":"9.0.0"}');
  }) as typeof fetch;
  assert.equal(await checkForUpdate('0.1.0', '', counting), null);
  assert.equal(await checkForUpdate('0.1.0', 'file:///etc/passwd', counting), null);
  assert.equal(calls, 0);
});
