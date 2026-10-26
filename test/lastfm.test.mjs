import test from 'node:test';
import assert from 'node:assert/strict';
import { LastfmClient, SourceFailure } from '../lib/lastfm.mjs';

const NOW = Date.parse('2026-10-24T15:00:00Z');
const playing = { recenttracks: { track: [{ name: 'Björk 🎵', artist: { '#text': 'Árbol' }, '@attr': { nowplaying: 'true' } }] } };
const idle = { recenttracks: { track: [{ name: 'An old scrobble', artist: { '#text': 'Someone' }, date: { uts: '1700000000' } }] } };
function response(body = playing, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}
function client(fetchImpl, options = {}) {
  return new LastfmClient({ username: 'test-user', apiKey: 'not-a-real-key', now: () => NOW, fetchImpl, ...options });
}

test('fixed HTTPS endpoint, encoded credentials, identifying User-Agent and no redirects', async () => {
  let requested;
  const source = client(async (url, options) => {
    requested = { url: new URL(url), options };
    return response();
  }, { username: 'álbum & user', apiKey: 'not-real&?=' });
  const result = await source.poll();
  assert.equal(requested.url.origin, 'https://ws.audioscrobbler.com');
  assert.equal(requested.url.pathname, '/2.0/');
  assert.equal(requested.url.searchParams.get('user'), 'álbum & user');
  assert.equal(requested.url.searchParams.get('api_key'), 'not-real&?=');
  assert.equal(requested.url.searchParams.get('method'), 'user.getRecentTracks');
  assert.equal(requested.url.searchParams.get('limit'), '1');
  assert.ok(requested.options.headers['User-Agent']);
  assert.equal(requested.options.redirect, 'error');
  assert.equal(result.observation.kind, 'playing');
  assert.equal(result.observation.artist, 'Árbol');
  assert.equal(result.observation.title, 'Björk 🎵');
  assert.equal(result.nextDelayMs, 30_000);
  assert.equal(result.receivedAt, NOW);
});

test('an old scrobble without nowplaying is an idle observation', async () => {
  assert.equal((await client(async () => response(idle)).poll()).observation.kind, 'idle');
});

test('overlapping polls share one in-flight request, then allow a new request', async () => {
  let finish;
  let calls = 0;
  const source = client(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const first = source.poll();
  const second = source.poll();
  assert.equal(first, second);
  assert.equal(calls, 1);
  finish(response());
  await first;
  const third = source.poll();
  assert.equal(calls, 2);
  finish(response(idle));
  assert.equal((await third).observation.kind, 'idle');
});

test('temporary API failures never become idle and expose no raw message', async () => {
  for (const code of [11, 16, 29]) {
    const source = client(async () => response({ error: code, message: 'SECRET should never escape' }));
    await assert.rejects(source.poll(), error => {
      assert.ok(error instanceof SourceFailure);
      assert.equal(error.code, `LASTFM_API_${code}`);
      assert.equal(error.permanent, false);
      assert.doesNotMatch(error.stack, /SECRET/);
      return true;
    });
  }
});

test('configuration API errors are permanent even when HTTP status is not 200', async () => {
  for (const code of [6, 10, 26]) {
    for (const status of [200, 400, 403]) {
      await assert.rejects(client(async () => response({ error: code }, { status })).poll(), error =>
        error.code === `LASTFM_API_${code}` && error.permanent === true);
    }
  }
});

test('Retry-After accepts seconds and HTTP date on server failures', async () => {
  for (const value of ['120', new Date(NOW + 120_000).toUTCString()]) {
    await assert.rejects(client(async () => response({}, { status: 503, headers: { 'Retry-After': value } })).poll(), error =>
      error.code === 'LASTFM_HTTP_503' && error.retryAfterMs === 120_000);
  }
});

test('HTTP rate limiting is distinguishable from valid absence', async () => {
  await assert.rejects(client(async () => response({}, { status: 429 })).poll(), { code: 'LASTFM_HTTP_429' });
});

test('Cache-Control max-age uses elapsed response age when scheduling', async () => {
  const result = await client(async () => response(playing, { headers: {
    'Cache-Control': 'public, max-age="120"', Age: '20', Date: new Date(NOW - 20_000).toUTCString(),
  } })).poll();
  assert.equal(result.nextDelayMs, 100_000);
});

test('Expires is respected and no-cache overrides max-age', async () => {
  const expiresResult = await client(async () => response(playing, { headers: {
    Date: new Date(NOW).toUTCString(), Expires: new Date(NOW + 100_000).toUTCString(),
  } })).poll();
  assert.equal(expiresResult.nextDelayMs, 100_000);
  const noCacheResult = await client(async () => response(playing, { headers: {
    'Cache-Control': 'no-cache, max-age=600',
  } })).poll();
  assert.equal(noCacheResult.nextDelayMs, 30_000);
});

test('stale Age or Date rejects a response, including a misleading cached idle', async () => {
  for (const headers of [{ Age: '91' }, { Date: new Date(NOW - 91_000).toUTCString() }]) {
    await assert.rejects(client(async () => response(idle, { headers })).poll(), { code: 'LASTFM_STALE_RESPONSE' });
  }
  const result = await client(async () => response(playing, { headers: { Date: new Date(NOW + 5_000).toUTCString() } })).poll();
  assert.equal(result.observation.kind, 'playing');
});

test('missing Date is accepted, but malformed JSON/schema never represents silence', async () => {
  assert.equal((await client(async () => response()).poll()).observation.kind, 'playing');
  await assert.rejects(client(async () => new Response('{broken')).poll(), { code: 'LASTFM_INVALID_JSON' });
  await assert.rejects(client(async () => response({ unexpected: [] })).poll(), error =>
    ['LASTFM_INVALID_RESPONSE', 'LASTFM_PARSE_FAILURE'].includes(error.code));
});

test('network failures are sanitized and next poll can recover', async () => {
  let calls = 0;
  const source = client(async () => {
    if (++calls === 1) throw new Error('https://example.invalid/?api_key=SECRET');
    return response();
  });
  await assert.rejects(source.poll(), error => {
    assert.equal(error.code, 'LASTFM_NETWORK');
    assert.doesNotMatch(error.stack, /SECRET|example\.invalid/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal((await source.poll()).observation.kind, 'playing');
});

test('timeout is bounded even if an injected transport ignores AbortSignal', async () => {
  const source = client(() => new Promise(() => {}), { timeoutMs: 15 });
  await assert.rejects(source.poll(), { code: 'LASTFM_TIMEOUT' });
  assert.equal(source.inFlight, null);
});

test('timeout also covers a stalled body', async () => {
  const source = client(async () => ({ ok: true, status: 200, headers: new Headers(), json: () => new Promise(() => {}) }), { timeoutMs: 15 });
  await assert.rejects(source.poll(), { code: 'LASTFM_TIMEOUT' });
});

test('invalid configuration fails locally without echoing credentials', () => {
  assert.throws(() => client(async () => response(), { username: '', apiKey: 'SECRET' }), error => {
    assert.equal(error.code, 'LASTFM_CONFIG_INVALID');
    assert.equal(error.permanent, true);
    assert.doesNotMatch(error.stack, /SECRET/);
    return true;
  });
});

