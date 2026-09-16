'use strict';

/**
 * Bounded HTML fetch, shared by every content-source handler.
 *
 * Every one of them reaches out to third-party sites from a Lambda, so they all
 * need the same guard rails: a hard timeout, a size ceiling, a content-type
 * check, and a User-Agent that says what we are.
 */

const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024;

const USER_AGENT =
  'Mozilla/5.0 (compatible; rss-feed-update-daemon/1.0; +personal-reader)';

/**
 * @returns {Promise<{html: string, finalUrl: string}>}
 * @throws on non-2xx, wrong content-type, oversize body, or timeout.
 */
async function fetchHtml(url, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en',
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const type = res.headers.get('content-type') || '';
  if (type && !/text\/html|application\/xhtml|text\/plain/i.test(type)) {
    throw new Error(`unsupported content-type: ${type.split(';')[0]}`);
  }

  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`page too large (${declared} bytes)`);

  // content-length is often absent, so the cap is enforced after reading too.
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new Error(`page too large (${buf.byteLength} bytes)`);

  return { html: new TextDecoder('utf-8').decode(buf), finalUrl: res.url || url };
}

/** Normalize a thrown fetch error into something worth storing. */
function describeFetchError(err, timeoutMs = DEFAULT_TIMEOUT_MS) {
  // AbortSignal.timeout surfaces as TimeoutError, whose message is empty.
  if (err?.name === 'TimeoutError') return `timed out after ${timeoutMs}ms`;
  return err?.message || String(err);
}

module.exports = { fetchHtml, describeFetchError, USER_AGENT, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BYTES };
