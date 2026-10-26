/** Deterministic sync logic. No network, browser, secrets, timers or file I/O. */
export const IDLE_TEXT = 'No music, just thoughts';

export class SourceError extends Error {
  constructor(code, { transient = true } = {}) {
    super(`Last.fm: ${code}`);
    this.name = 'SourceError';
    this.code = code;
    this.transient = transient;
  }
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clean = value => String(value).normalize('NFC').replace(/\s+/gu, ' ').replace(/\p{Cc}/gu, '').trim();

/** Only an explicit nowplaying flag is playback. Recent scrobbles are never playback. */
export function parseLastfm(payload) {
  if (!record(payload)) throw new SourceError('INVALID_RESPONSE');
  if (Object.hasOwn(payload, 'error')) {
    const code = Number(payload.error);
    if (!Number.isSafeInteger(code)) throw new SourceError('INVALID_RESPONSE');
    throw new SourceError(`API_${code}`, { transient: [8, 11, 16, 29].includes(code) });
  }
  if (!record(payload.recenttracks) || !Object.hasOwn(payload.recenttracks, 'track')) throw new SourceError('INVALID_RESPONSE');
  const value = payload.recenttracks.track;
  const tracks = Array.isArray(value) ? value : record(value) ? [value] : null;
  if (!tracks) throw new SourceError('INVALID_RESPONSE');
  const active = [];
  for (const track of tracks) {
    if (!record(track)) throw new SourceError('INVALID_RESPONSE');
    const artistValue = typeof track.artist === 'string' ? track.artist : track.artist?.['#text'];
    if (typeof track.name !== 'string' || typeof artistValue !== 'string') throw new SourceError('INVALID_RESPONSE');
    const artist = clean(artistValue);
    const title = clean(track.name);
    if (!artist || !title) throw new SourceError('INVALID_RESPONSE');
    if (track['@attr'] !== undefined && !record(track['@attr'])) throw new SourceError('INVALID_RESPONSE');
    const flag = track['@attr']?.nowplaying;
    if (![undefined, true, false, 'true', 'false'].includes(flag)) throw new SourceError('INVALID_RESPONSE');
    if (flag === true || flag === 'true') active.push({ kind: 'playing', artist, title });
  }
  if (active.length > 1) throw new SourceError('AMBIGUOUS_PLAYBACK');
  return active[0] ?? { kind: 'idle' };
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemes = value => Array.from(segmenter.segment(value), item => item.segment);
export function textLength(text, unit = 'codepoints') {
  if (unit === 'codepoints') return Array.from(text).length;
  if (unit === 'utf16') return text.length;
  throw new TypeError('lengthUnit debe ser codepoints o utf16');
}
function clip(text, budget, unit) {
  if (textLength(text, unit) <= budget) return text;
  if (budget <= 0) return '';
  let result = '';
  for (const part of graphemes(text)) {
    if (textLength(result + part, unit) > budget - 1) break;
    result += part;
  }
  return result + '…';
}
/** Retain complete graphemes and allocate room to both artist and title. */
export function formatTrack(artist, title, { maxLength = 50, lengthUnit = 'codepoints' } = {}) {
  if (!Number.isSafeInteger(maxLength) || maxLength < 22) throw new RangeError('maxLength debe ser al menos 22');
  if (typeof artist !== 'string' || typeof title !== 'string') throw new TypeError('Artista y canción deben ser texto');
  artist = clean(artist);
  title = clean(title);
  if (!artist || !title) throw new TypeError('Artista y canción no pueden estar vacíos');
  const full = `♬ Now listening: ${artist} - ${title}`;
  if (textLength(full, lengthUnit) <= maxLength) return full;
  const remaining = maxLength - '♬ Now listening: '.length - 3;
  const artistSize = textLength(artist, lengthUnit);
  const titleSize = textLength(title, lengthUnit);
  let artistBudget = Math.min(artistSize, Math.floor(remaining / 2));
  let titleBudget = Math.min(titleSize, remaining - artistBudget);
  artistBudget = Math.min(artistSize, remaining - titleBudget);
  let a = clip(artist, artistBudget, lengthUnit);
  titleBudget = remaining - textLength(a, lengthUnit);
  const t = clip(title, titleBudget, lengthUnit);
  artistBudget = remaining - textLength(t, lengthUnit);
  a = clip(artist, artistBudget, lengthUnit);
  return `♬ Now listening: ${a} - ${t}`;
}
const nonnegative = (value, name) => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} debe ser un número no negativo`);
  return value;
};

/**
 * Driver contract:
 * request=startRequest(now); accept(request,parseLastfm(body),now) or fail(request,now).
 * candidate=next(now); check isCurrent(candidate,now) immediately before committing UI.
 * After reading the saved UI value back, acknowledge(candidate,now), persist snapshot().
 * Serialize UI writes. Acknowledging an obsolete but actually committed value records
 * reality; the next candidate corrects it. Observations never survive process restart.
 * force is exclusively for renewal after the adapter verifies the field expiry policy.
 */
export class SyncState {
  constructor({ idleGraceMs = 90000, debounceMs = 0, maxObservationAgeMs = 90000,
    maxLength = 50, lengthUnit = 'codepoints', persisted = {}, idleText = IDLE_TEXT } = {}) {
    this.idleGraceMs = nonnegative(idleGraceMs, 'idleGraceMs');
    this.debounceMs = nonnegative(debounceMs, 'debounceMs');
    this.maxObservationAgeMs = nonnegative(maxObservationAgeMs, 'maxObservationAgeMs');
    if (!Number.isSafeInteger(maxLength) || maxLength < IDLE_TEXT.length) throw new RangeError(`maxLength debe permitir el texto de descanso (${IDLE_TEXT.length})`);
    textLength('', lengthUnit);
    this.formatOptions = { maxLength, lengthUnit };
    this.idleText = idleText;
    this.validateIdleText(idleText);
    this.sequence = 0;
    this.processedSequence = 0;
    this.revision = 0;
    this.observation = null;
    this.healthy = false;
    this.silenceSince = null;
    this.changedAt = null;
    const ack = persisted?.lastAcknowledged;
    this.lastAcknowledged = record(ack) && typeof ack.text === 'string' && Number.isFinite(ack.at)
      ? { text: ack.text, at: ack.at } : null;
  }
  validateIdleText(text) {
    if (typeof text !== 'string' || !text.trim() || /[\r\n]/.test(text) || textLength(text, this.formatOptions.lengthUnit) > this.formatOptions.maxLength) throw new RangeError('IDLE_TEXT_INVALID');
  }
  setIdleText(text) {
    this.validateIdleText(text);
    if (text !== this.idleText) { this.idleText = text; this.revision++; }
  }
  startRequest(now) {
    nonnegative(now, 'now');
    return Object.freeze({ id: ++this.sequence, startedAt: now });
  }
  isNewestRequest(request) {
    return record(request) && request.id === this.sequence && request.id > this.processedSequence;
  }
  accept(request, observation, now) {
    nonnegative(now, 'now');
    if (!this.isNewestRequest(request)) return false;
    if (!Number.isFinite(request.startedAt) || request.startedAt > now || now - request.startedAt > this.maxObservationAgeMs) {
      this.fail(request, now);
      return false;
    }
    if (!record(observation) || !['playing', 'idle'].includes(observation.kind)) throw new TypeError('Observación inválida');
    const normalized = observation.kind === 'playing'
      ? { kind: 'playing', artist: clean(observation.artist ?? ''), title: clean(observation.title ?? '') }
      : { kind: 'idle' };
    if (normalized.kind === 'playing' && (!normalized.artist || !normalized.title)) throw new TypeError('Canción inválida');
    const fingerprint = JSON.stringify(normalized);
    const old = this.observation;
    const uninterrupted = this.healthy && old && now >= old.receivedAt && now - old.observedAt <= this.maxObservationAgeMs;
    if (!uninterrupted || old.fingerprint !== fingerprint) {
      this.revision++;
      this.changedAt = now;
    }
    if (normalized.kind === 'idle') {
      if (!uninterrupted || old.kind !== 'idle') this.silenceSince = now;
    } else this.silenceSince = null;
    this.processedSequence = request.id;
    this.healthy = true;
    this.observation = { ...normalized, fingerprint, observedAt: request.startedAt, receivedAt: now };
    return true;
  }
  fail(request, now) {
    nonnegative(now, 'now');
    if (!this.isNewestRequest(request)) return false;
    this.processedSequence = request.id;
    this.healthy = false;
    this.silenceSince = null;
    this.changedAt = null;
    this.revision++;
    return true;
  }
  next(now, { force = false } = {}) {
    nonnegative(now, 'now');
    const observed = this.observation;
    if (!this.healthy || !observed || now < observed.receivedAt || now - observed.observedAt > this.maxObservationAgeMs) return null;
    let text;
    if (observed.kind === 'idle') {
      if (this.silenceSince === null || now - this.silenceSince < this.idleGraceMs) return null;
      text = this.idleText;
    } else {
      if (this.changedAt === null || now - this.changedAt < this.debounceMs) return null;
      text = formatTrack(observed.artist, observed.title, this.formatOptions);
    }
    if (!force && this.lastAcknowledged?.text === text) return null;
    return Object.freeze({ revision: this.revision, text, observedAt: observed.observedAt });
  }
  isCurrent(candidate, now) {
    if (!candidate) return false;
    const latest = this.next(now, { force: true });
    return latest !== null && latest.revision === candidate.revision && latest.text === candidate.text;
  }
  acknowledge(candidate, now) {
    nonnegative(now, 'now');
    if (!record(candidate) || typeof candidate.text !== 'string' || !Number.isSafeInteger(candidate.revision)) throw new TypeError('Confirmación inválida');
    const current = this.isCurrent(candidate, now);
    this.lastAcknowledged = { text: candidate.text, at: now };
    return current;
  }
  snapshot() {
    return { version: 1, lastAcknowledged: this.lastAcknowledged ? { ...this.lastAcknowledged } : null };
  }
}

