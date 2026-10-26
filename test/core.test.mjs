import test from 'node:test';
import assert from 'node:assert/strict';
import { IDLE_TEXT, SourceError, parseLastfm, formatTrack, textLength, SyncState } from '../lib/core.mjs';

const track = (name = 'Canción', nowplaying = 'true') => ({ name, artist: { '#text': 'Artista' }, ...(nowplaying === null ? {} : { '@attr': { nowplaying } }) });
const payload = tracks => ({ recenttracks: { track: tracks } });
const playing = (title = 'Canción', artist = 'Artista') => ({ kind: 'playing', artist, title });
const idle = { kind: 'idle' };
const observe = (s, observation, now) => s.accept(s.startRequest(now), observation, now);

test('explicit nowplaying flags are the only playback signal', () => {
  assert.deepEqual(parseLastfm(payload([track()])), playing());
  assert.deepEqual(parseLastfm(payload(track('Otra', true))), playing('Otra'));
  for (const flag of [false, 'false', null]) assert.deepEqual(parseLastfm(payload([track('Scrobble reciente', flag)])), idle);
  assert.deepEqual(parseLastfm(payload([])), idle);
});
test('malformed and API errors never become silence', () => {
  for (const value of [null, {}, { recenttracks: {} }, payload(null), payload([{}]), payload([track('', true)]), payload([track('X', 'yes')]), payload([track(), track('Ambigua')])]) {
    assert.throws(() => parseLastfm(value), SourceError);
  }
  assert.throws(() => parseLastfm({ error: 29, message: 'untrusted key=secret' }), e => e.code === 'API_29' && e.transient && !e.message.includes('secret'));
  assert.throws(() => parseLastfm({ error: 10 }), e => !e.transient);
});
test('short text is exact; international text is kept', () => {
  assert.equal(formatTrack('Björk', 'Jóga'), '♬ Now listening: Björk - Jóga');
  assert.equal(formatTrack('宇多田ヒカル', '道 🎵'), '♬ Now listening: 宇多田ヒカル - 道 🎵');
  assert.equal(formatTrack('  A\nB ', ' cafe\u0301\tX '), '♬ Now listening: A B - café X');
});
test('long labels preserve both sides within both supported units', () => {
  for (const lengthUnit of ['codepoints', 'utf16']) {
    const result = formatTrack('Un artista de nombre extraordinariamente largo', 'Una canción de título extraordinariamente largo 🎧', { maxLength: 50, lengthUnit });
    assert.ok(textLength(result, lengthUnit) <= 50);
    assert.match(result, /^♬ Now listening: Un artista.*… - Una canción.*…$/u);
    assert.equal(formatTrack('A', 'x'.repeat(80), { maxLength: 23, lengthUnit }), '♬ Now listening: A - ' + 'x'.repeat(1) + '…');
  }
});
test('truncation never splits combining marks or emoji grapheme clusters', () => {
  const family = '👩‍👩‍👧‍👦';
  for (const lengthUnit of ['codepoints', 'utf16']) {
    for (let maxLength = 23; maxLength < 70; maxLength++) {
      const value = formatTrack(family.repeat(12), '🇨🇴'.repeat(20), { maxLength, lengthUnit });
      assert.ok(textLength(value, lengthUnit) <= maxLength);
      const [a, t] = value.slice('♬ Now listening: '.length).split(' - ');
      assert.equal(a.replaceAll(family, '').replace('…', ''), '');
      assert.equal(t.replaceAll('🇨🇴', '').replace('…', ''), '');
    }
  }
});
test('playing then next track produces only changed desired text', () => {
  const s = new SyncState();
  assert.equal(s.next(0), null);
  observe(s, playing(), 0);
  const first = s.next(0);
  assert.equal(first.text, '♬ Now listening: Artista - Canción');
  assert.equal(s.acknowledge(first, 1), true);
  observe(s, playing(), 30000);
  assert.equal(s.next(30000), null);
  observe(s, playing('Otra'), 60000);
  assert.equal(s.next(60000).text, '♬ Now listening: Artista - Otra');
});
test('idle grace prevents transient rest text between songs', () => {
  const s = new SyncState({ idleGraceMs: 60000, maxObservationAgeMs: 40000 });
  observe(s, playing(), 0);
  s.acknowledge(s.next(0), 0);
  observe(s, idle, 10000);
  assert.equal(s.next(30000), null);
  observe(s, playing('Segunda'), 35000);
  assert.equal(s.next(35000).text, '♬ Now listening: Artista - Segunda');
  observe(s, idle, 40000);
  observe(s, idle, 70000);
  assert.equal(s.next(99999), null);
  observe(s, idle, 100000);
  assert.equal(s.next(100000).text, IDLE_TEXT);
});
test('temporary failure freezes writes and restarts silence evidence', () => {
  const s = new SyncState({ idleGraceMs: 60000 });
  observe(s, idle, 0);
  s.fail(s.startRequest(30000), 30000);
  assert.equal(s.next(65000), null);
  observe(s, idle, 70000);
  assert.equal(s.next(70000), null);
  observe(s, idle, 100000);
  assert.equal(s.next(129999), null);
  observe(s, idle, 130000);
  assert.equal(s.next(130000).text, IDLE_TEXT);
});
test('silence evidence is restarted after a stale gap or sleep', () => {
  const s = new SyncState({ idleGraceMs: 60000, maxObservationAgeMs: 40000 });
  observe(s, idle, 0);
  assert.equal(s.next(120000), null);
  observe(s, idle, 120000);
  assert.equal(s.next(120000), null);
  observe(s, idle, 150000);
  observe(s, idle, 180000);
  assert.equal(s.next(180000).text, IDLE_TEXT);
});
test('delayed older responses, errors and repeated callbacks are ignored', () => {
  const s = new SyncState();
  const old = s.startRequest(0);
  const fresh = s.startRequest(1000);
  assert.equal(s.accept(fresh, playing('Nueva'), 2000), true);
  assert.equal(s.accept(old, playing('Vieja'), 3000), false);
  assert.equal(s.fail(old, 4000), false);
  assert.equal(s.accept(fresh, idle, 5000), false);
  assert.equal(s.next(5000).text, '♬ Now listening: Artista - Nueva');
});
test('expired in-flight response and backwards clocks suspend writes', () => {
  const s = new SyncState({ maxObservationAgeMs: 1000 });
  const request = s.startRequest(0);
  assert.equal(s.accept(request, playing(), 1001), false);
  assert.equal(s.next(1001), null);
  observe(s, playing(), 2000);
  assert.equal(s.next(1999), null);
  assert.equal(s.next(3001), null);
});
test('latest track invalidates pending update; obsolete confirmed write is corrected', () => {
  const s = new SyncState();
  observe(s, playing('Primera'), 0);
  const old = s.next(0);
  observe(s, playing('Segunda'), 1000);
  assert.equal(s.isCurrent(old, 1000), false);
  assert.equal(s.acknowledge(old, 1001), false);
  assert.equal(s.next(1001).text, '♬ Now listening: Artista - Segunda');
  s.acknowledge(s.next(1001), 1002);
  assert.equal(s.next(1002), null);
});
test('idle observation invalidates pending song before idle grace', () => {
  const s = new SyncState();
  observe(s, playing(), 0);
  const candidate = s.next(0);
  observe(s, idle, 1000);
  assert.equal(s.isCurrent(candidate, 1000), false);
  assert.equal(s.next(1000), null);
});
test('rapid switches coalesce with debounce and identical polls do not reset it', () => {
  const s = new SyncState({ debounceMs: 5000 });
  observe(s, playing('A'), 0);
  observe(s, playing('B'), 1000);
  observe(s, playing('C'), 2000);
  assert.equal(s.next(6000), null);
  observe(s, playing('C'), 6000);
  assert.equal(s.next(7000).text, '♬ Now listening: Artista - C');
});
test('restart restores only confirmed state and avoids duplicate write', () => {
  const before = new SyncState();
  observe(before, playing(), 0);
  before.acknowledge(before.next(0), 1);
  const saved = JSON.parse(JSON.stringify(before.snapshot()));
  const after = new SyncState({ persisted: saved });
  assert.equal(after.next(100000), null);
  observe(after, playing(), 100000);
  assert.equal(after.next(100000), null);
  observe(after, playing('Nueva'), 130000);
  assert.equal(after.next(130000).text, '♬ Now listening: Artista - Nueva');
});
test('verified expiry renewal can bypass text deduplication, but not stale source', () => {
  const s = new SyncState();
  observe(s, playing(), 0);
  s.acknowledge(s.next(0), 1);
  assert.equal(s.next(1), null);
  assert.equal(s.next(1, { force: true }).text, '♬ Now listening: Artista - Canción');
  assert.equal(s.next(90001, { force: true }), null);
});
test('session failure causes no acknowledgement; fresh desired survives reconnection', () => {
  const s = new SyncState();
  observe(s, playing('A'), 0);
  // Adapter reports SESSION_REQUIRED and does not acknowledge a write.
  observe(s, playing('B'), 30000);
  assert.equal(s.snapshot().lastAcknowledged, null);
  const afterRelink = s.next(30000);
  assert.equal(afterRelink.text, '♬ Now listening: Artista - B');
  s.acknowledge(afterRelink, 30001);
  assert.equal(s.next(30001), null);
});
test('invalid settings cannot truncate required exact idle text', () => {
  assert.throws(() => new SyncState({ maxLength: 10 }), RangeError);
  assert.throws(() => new SyncState({ idleGraceMs: -1 }), RangeError);
  assert.throws(() => new SyncState({ lengthUnit: 'bytes' }), TypeError);
});


