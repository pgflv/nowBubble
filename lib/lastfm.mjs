import { parseLastfm, SourceError } from './core.mjs';

const ENDPOINT = 'https://ws.audioscrobbler.com/2.0/';
const PERMANENT_API_ERRORS = new Set([6, 10, 26]);

/** Safe to display: never contains a URL, key, username or server message. */
export class SourceFailure extends Error {
  constructor(code, { retryAfterMs = 0, permanent = false } = {}) {
    super(code);
    this.name = 'SourceFailure';
    this.code = code;
    this.retryAfterMs = Math.max(0, Number(retryAfterMs) || 0);
    this.permanent = permanent;
  }
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function header(response, name) {
  return response.headers?.get?.(name) ?? null;
}

function dateMs(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function responseAgeMs(response, now) {
  const rawAge = header(response, 'age');
  const age = rawAge !== null && /^\d+$/.test(rawAge.trim()) ? Number(rawAge) * 1000 : 0;
  const serverDate = dateMs(header(response, 'date'));
  // A missing Date is allowed. A future Date does not make Age disappear.
  return Math.max(age, serverDate === null ? 0 : now - serverDate, 0);
}

function retryAfterMs(response, now) {
  const value = header(response, 'retry-after');
  if (!value) return 0;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  const until = dateMs(value);
  return until === null ? 0 : Math.max(0, until - now);
}

function cacheDelayMs(response, now) {
  const cacheControl = header(response, 'cache-control') ?? '';
  if (/(?:^|,)\s*(?:no-cache|no-store)(?:\s|,|=|$)/i.test(cacheControl)) return 0;
  const match = cacheControl.match(/(?:^|,)\s*max-age\s*=\s*"?(\d+)"?(?:\s|,|$)/i);
  const age = responseAgeMs(response, now);
  if (match) return Math.max(0, Number(match[1]) * 1000 - age);
  const expires = dateMs(header(response, 'expires'));
  if (expires === null) return 0;
  const serverDate = dateMs(header(response, 'date')) ?? now;
  return Math.max(0, expires - serverDate - age);
}

/**
 * Poll one fixed HTTPS endpoint. Calls while a request is running share it.
 * The caller schedules the next poll using nextDelayMs (and backoff on failure).
 * No cached result is returned as new evidence that music has stopped.
 */
export class LastfmClient {
  constructor({ username, apiKey, pollIntervalMs = 30_000, timeoutMs = 10_000,
    maxResponseAgeMs = 90_000, fetchImpl = fetch, now = Date.now } = {}) {
    if (typeof username !== 'string' || !username.trim() ||
        typeof apiKey !== 'string' || !apiKey.trim() ||
        ![pollIntervalMs, timeoutMs, maxResponseAgeMs].every(positiveNumber) ||
        typeof fetchImpl !== 'function' || typeof now !== 'function') {
      throw new SourceFailure('LASTFM_CONFIG_INVALID', { permanent: true });
    }
    this.username = username.trim();
    this.apiKey = apiKey.trim();
    this.pollIntervalMs = pollIntervalMs;
    this.timeoutMs = timeoutMs;
    this.maxResponseAgeMs = maxResponseAgeMs;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.inFlight = null;
  }

  poll() {
    if (!this.inFlight) {
      this.inFlight = this.request().finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  async request() {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new SourceFailure('LASTFM_TIMEOUT'));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.fetchAndParse(controller.signal), timeout]);
    } catch (error) {
      if (error instanceof SourceFailure) throw error;
      // Native fetch errors can contain URL secrets, including inside cause.
      throw new SourceFailure(controller.signal.aborted ? 'LASTFM_TIMEOUT' : 'LASTFM_NETWORK');
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchAndParse(signal) {
    const url = new URL(ENDPOINT);
    url.search = new URLSearchParams({ method: 'user.getRecentTracks', user: this.username,
      api_key: this.apiKey, format: 'json', limit: '1', extended: '0' }).toString();
    const response = await this.fetchImpl(url, { signal, redirect: 'error', headers: {
      Accept: 'application/json', 'User-Agent': 'PersonalLastfmWhatsAppSync/1.0',
    } });
    const receivedHeadersAt = this.now();
    const retry = retryAfterMs(response, receivedHeadersAt);
    const cacheDelay = cacheDelayMs(response, receivedHeadersAt);
    if (!response.ok) {
      // Last.fm may return an API error alongside a non-2xx HTTP response.
      let errorCode;
      try { errorCode = Number((await response.json())?.error); } catch { /* use HTTP status */ }
      if (Number.isInteger(errorCode) && errorCode > 0) {
        throw new SourceFailure(`LASTFM_API_${errorCode}`, {
          retryAfterMs: Math.max(retry, cacheDelay), permanent: PERMANENT_API_ERRORS.has(errorCode),
        });
      }
      throw new SourceFailure(`LASTFM_HTTP_${Number(response.status) || 0}`, { retryAfterMs: Math.max(retry, cacheDelay) });
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw new SourceFailure('LASTFM_INVALID_JSON', { retryAfterMs: cacheDelay }); }
    const receivedAt = this.now();
    if (payload && Object.hasOwn(payload, 'error')) {
      const errorCode = Number(payload.error);
      throw new SourceFailure(Number.isInteger(errorCode) && errorCode > 0 ? `LASTFM_API_${errorCode}` : 'LASTFM_API_ERROR', {
        retryAfterMs: Math.max(retry, cacheDelay), permanent: PERMANENT_API_ERRORS.has(errorCode),
      });
    }
    if (responseAgeMs(response, receivedAt) > this.maxResponseAgeMs) {
      throw new SourceFailure('LASTFM_STALE_RESPONSE', { retryAfterMs: Math.max(retry, cacheDelay) });
    }
    let observation;
    try { observation = parseLastfm(payload); }
    catch (error) {
      throw new SourceFailure(error instanceof SourceError ? 'LASTFM_INVALID_RESPONSE' : 'LASTFM_PARSE_FAILURE', {
        retryAfterMs: cacheDelay,
      });
    }
    return { observation, receivedAt,
      nextDelayMs: Math.max(this.pollIntervalMs, retryAfterMs(response, receivedAt), cacheDelayMs(response, receivedAt)) };
  }
}
