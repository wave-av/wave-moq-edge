#!/usr/bin/env node
// GAM deploy-bound lever — CANARY PROBE (the L3 progressive-delivery gate), 3-STATE VERSION.
//
// After a deploy, this probes the freshly-deployed surface and decides whether the deploy is
// HEALTHY, REGRESSED, or the probe must REFUSE-TO-EVALUATE. A bare HTTP 200 is NOT proof (a
// holding page, a stale worker, a shadowed route all 200) — so the probe REQUIRES a content
// marker (and optionally a JSON field, a response header, or a status) that only the RIGHT,
// current build serves.
//
// THE THIRD STATE (REL-003 fix, 2026-09-05): the prior version of this probe collapsed "the
// deploy is provably wrong" and "the probe could not get a determinate answer at all" (DNS
// failure, every attempt timed out, the runner had no egress) into a single boolean `healthy:
// false`. That is directionally safe here (false triggers rollback, not promotion) but it is
// indistinguishable in the receipt from a genuine regression, and — more importantly — a caller
// that reads this receipt for a PROMOTE decision (not just a rollback decision) needs to know
// "I never got an answer" is NOT "it answered healthy". REFUSE is now a first-class state:
//   healthy   — a determinate response was received and it satisfies every configured criterion.
//   regressed — a determinate response was received and it FAILS at least one criterion (proof
//               of a bad build: wrong marker, wrong status, wrong header, wrong JSON field).
//   refuse    — no determinate response was ever obtained (every attempt errored/timed out), or
//               the probe was misconfigured. The caller MUST treat this exactly like `regressed`
//               for promotion/rollback purposes — refuse is fail-closed, never fail-open — but it
//               is reported separately so an operator can tell "definitely broken" from
//               "couldn't tell" instead of both reading as an identical false.
//
// This is deliberately repo-agnostic: everything is passed by env so the same probe serves any
// Worker/edge surface. It performs NO deploy and NO rollback itself — it only returns a verdict +
// a receipt; the calling workflow owns the (repo-specific) rollback command.
//
// TRANSPORT SAFETY (review sweep, 2026-09-06): CANARY_HEADERS may legitimately carry an internal
// auth token, and the verdict this probe returns can dispatch a production rollback. So the
// transport is pinned, not merely conventional:
//   · the URL must be https (loopback is the only exception — a 127.0.0.1/::1 probe used by the
//     unit tests cannot be observed by an on-path attacker, and there is no CA for it);
//   · redirects are followed MANUALLY, capped, and each hop must be https AND same-origin, so a
//     redirect can neither exfiltrate the request headers to a third party nor substitute an
//     unrelated origin's body/status as "production health".
//
// INPUT VALIDATION: every numeric input is required to be a finite integer inside an explicit
// range. `MAX_ATTEMPTS=Infinity` (an unterminated retry loop that never reaches rollback) and
// `MAX_ATTEMPTS=abc` (NaN → zero probes → `attempts:null`) are both config REFUSALS, not
// silently-accepted values.
//
// Env (all optional except URL + one acceptance criterion):
//   CANARY_URL         (required) https URL to probe (loopback may be http).
//   CANARY_METHOD      HTTP method (default GET).
//   CANARY_BODY        request body (for POST/PUT).
//   CANARY_HEADERS     JSON object of request headers.
//   EXPECT_MARKER      substring that MUST appear in the response body (the "right build" proof).
//   EXPECT_JSON        "dotted.path=value" — parse the body as JSON and require an EXACT match at
//                      that path. Prefer this over EXPECT_MARKER for JSON surfaces: a substring
//                      match on serialized JSON is whitespace-fragile (`{"sha":"x"}` vs
//                      `{\n  "sha": "x"\n}` differ), and a marker that can never match turns every
//                      deploy into a spurious rollback.
//   EXPECT_HEADER      "Name: value-substr" that MUST appear in a response header. Both halves
//                      must be non-empty.
//   EXPECT_STATUS      expected HTTP status (default: any 2xx).
//   MAX_ATTEMPTS       retries before declaring a verdict (default 6, integer 1..100).
//   RETRY_DELAY_MS     delay between attempts (default 10000, integer 0..600000).
//   TIMEOUT_MS         per-request timeout (default 15000, integer 1000..300000).
//   MAX_REDIRECTS      same-origin redirect hops to follow (default 5, integer 0..10).
//
// Exit: 0 = healthy (deploy PROVEN live) · 1 = regressed (caller should ROLLBACK)
//       · 2 = usage/config error (REFUSE — nothing was probed) · 3 = refuse (probed, but every
//       attempt failed to produce a determinate answer — caller should ROLLBACK, same as regressed)
// Emits a JSON receipt to stdout on the last line (parse with `tail -1`), human lines to stderr.
//
// The exit code is set via `process.exitCode`, never `process.exit()`: stdout here is a pipe, and
// a forced exit is not guaranteed to flush it. A truncated receipt reads as `refuse` downstream
// and would fire a rollback on a perfectly healthy deploy.

const env = process.env;
const log = (m) => process.stderr.write(m + '\n');
const emit = (rec) => process.stdout.write(JSON.stringify(rec) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------- config validation
const configErrors = [];
const fail = (reason) => { configErrors.push(reason); };

/** A numeric input must be a FINITE INTEGER in [min,max]. NaN and Infinity are config errors. */
function intInRange(raw, def, min, max, name) {
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    fail(`${name}='${raw}' must be an integer in [${min}, ${max}]`);
    return def;
  }
  return n;
}

const rawUrl = env.CANARY_URL;
const method = (env.CANARY_METHOD || 'GET').toUpperCase();
const expectMarker = env.EXPECT_MARKER || '';
const expectHeader = env.EXPECT_HEADER || '';
const expectJson = env.EXPECT_JSON || '';
const expectStatus = env.EXPECT_STATUS ? Number(env.EXPECT_STATUS) : null;
const maxAttempts = intInRange(env.MAX_ATTEMPTS, 6, 1, 100, 'MAX_ATTEMPTS');
const retryDelay = intInRange(env.RETRY_DELAY_MS, 10000, 0, 600000, 'RETRY_DELAY_MS');
const timeoutMs = intInRange(env.TIMEOUT_MS, 15000, 1000, 300000, 'TIMEOUT_MS');
const maxRedirects = intInRange(env.MAX_REDIRECTS, 5, 0, 10, 'MAX_REDIRECTS');

/** Loopback is the one place plaintext is acceptable: it cannot be observed on-path, and no CA
 *  issues certificates for 127.0.0.1. Everything else on the public internet must be https, or
 *  an on-path attacker could both read CANARY_HEADERS (an internal token) and forge the very
 *  response criteria this probe uses to decide whether to roll production back. */
function isLoopback(u) {
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h === '127.0.0.1' || h.startsWith('127.');
}
function transportOk(u) {
  return u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback(u));
}

let target = null;
if (!rawUrl) {
  fail('CANARY_URL is required');
} else {
  try { target = new URL(rawUrl); }
  catch { fail(`CANARY_URL='${rawUrl}' is not a valid absolute URL`); }
  if (target && !transportOk(target)) {
    fail(`CANARY_URL must use https (got '${target.protocol}//') — a plaintext probe can be forged on-path and would leak CANARY_HEADERS`);
  }
}

if (!expectMarker && !expectHeader && !expectJson && expectStatus === null) {
  fail('need at least one of EXPECT_MARKER / EXPECT_JSON / EXPECT_HEADER / EXPECT_STATUS — a bare fetch is not proof');
}
// A non-empty EXPECT_STATUS that isn't a number would silently never match → a spurious rollback
// on every deploy. Reject it as a config error instead (fail-closed on misconfiguration).
if (expectStatus !== null && !Number.isFinite(expectStatus)) {
  fail(`EXPECT_STATUS='${env.EXPECT_STATUS}' is not a number`);
}

let headers = {};
if (env.CANARY_HEADERS) {
  try { headers = JSON.parse(env.CANARY_HEADERS); }
  catch { fail('CANARY_HEADERS is not valid JSON'); }
}

// Parse "Name: substr" once. BOTH halves must be non-empty: with `EXPECT_HEADER=':'` the old
// parse produced two empty strings, and `''.includes('')` is true — so the header criterion
// silently passed on ANY response, and a 2xx holding page could be promoted as healthy.
let hdrName = '', hdrWant = '';
if (expectHeader) {
  const i = expectHeader.indexOf(':');
  if (i < 0) {
    fail('EXPECT_HEADER must be "Name: value-substr"');
  } else {
    hdrName = expectHeader.slice(0, i).trim().toLowerCase();
    hdrWant = expectHeader.slice(i + 1).trim();
    if (!hdrName) fail(`EXPECT_HEADER='${expectHeader}' has an empty header name`);
    if (!hdrWant) fail(`EXPECT_HEADER='${expectHeader}' has an empty expected value — an empty substring matches every response and is not proof`);
  }
}

// Parse "dotted.path=value" once. The value may itself contain '=' (only the first splits).
let jsonPath = [], jsonWant = '';
if (expectJson) {
  const i = expectJson.indexOf('=');
  if (i < 0) {
    fail('EXPECT_JSON must be "dotted.path=value"');
  } else {
    const p = expectJson.slice(0, i).trim();
    jsonWant = expectJson.slice(i + 1);
    if (!p) fail(`EXPECT_JSON='${expectJson}' has an empty path`);
    if (!jsonWant) fail(`EXPECT_JSON='${expectJson}' has an empty expected value — that is not proof`);
    jsonPath = p.split('.').filter(Boolean);
  }
}

function readPath(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

// ------------------------------------------------------------------------------------- probing
/**
 * One attempt. Returns { determinate, ok, ... }.
 * `determinate: true` means a real HTTP answer was obtained and evaluated — the verdict from it
 * is PROOF (healthy or regressed). `determinate: false` means no answer at all (network, DNS,
 * TLS, timeout) and can only ever produce `refuse`.
 *
 * Redirects are followed manually so every hop can be checked: a cross-origin or plaintext hop
 * is rejected as a DETERMINATE failure (fail-closed → rollback), never followed. `redirect:
 * 'follow'` would have sent CANARY_HEADERS onward and then judged an unrelated origin's body and
 * status as production health.
 */
async function probeOnce() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let current = new URL(target.href);
    let curMethod = method;
    let res;
    for (let hop = 0; ; hop++) {
      res = await fetch(current.href, {
        method: curMethod,
        headers,
        body: (curMethod === 'GET' || curMethod === 'HEAD') ? undefined : (env.CANARY_BODY || undefined),
        signal: ctrl.signal,
        redirect: 'manual',
      });
      if (res.status < 300 || res.status >= 400) break;
      const loc = res.headers.get('location');
      if (!loc) break; // a 3xx with no Location is just a final response; evaluate it as-is.
      if (hop >= maxRedirects) {
        return { determinate: true, ok: false, status: res.status, statusOk: false, markerOk: false, hdrOk: false, jsonOk: false, redirectRejected: `exceeded MAX_REDIRECTS=${maxRedirects}` };
      }
      let next;
      try { next = new URL(loc, current); }
      catch { return { determinate: true, ok: false, status: res.status, statusOk: false, markerOk: false, hdrOk: false, jsonOk: false, redirectRejected: `unparseable Location '${String(loc).slice(0, 120)}'` }; }
      if (!transportOk(next)) {
        return { determinate: true, ok: false, status: res.status, statusOk: false, markerOk: false, hdrOk: false, jsonOk: false, redirectRejected: `plaintext redirect to '${next.protocol}//${next.host}'` };
      }
      if (next.origin !== target.origin) {
        return { determinate: true, ok: false, status: res.status, statusOk: false, markerOk: false, hdrOk: false, jsonOk: false, redirectRejected: `cross-origin redirect to '${next.origin}' (probe origin is '${target.origin}')` };
      }
      // Match platform redirect semantics: 303 always becomes GET; 301/302 downgrade a non-GET
      // to GET; 307/308 preserve the method and body.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && curMethod !== 'GET' && curMethod !== 'HEAD')) {
        curMethod = 'GET';
      }
      current = next;
    }

    const body = await res.text();
    const statusOk = expectStatus !== null ? res.status === expectStatus : (res.status >= 200 && res.status < 300);
    const markerOk = expectMarker ? body.includes(expectMarker) : true;
    // `has()` first: without it a MISSING header yields '' and `''.includes(want)` is false only
    // because want is non-empty — the explicit check keeps the receipt honest about WHY it failed.
    const hdrOk = expectHeader ? (res.headers.has(hdrName) && (res.headers.get(hdrName) || '').includes(hdrWant)) : true;
    let jsonOk = true, jsonValue;
    if (expectJson) {
      try {
        jsonValue = readPath(JSON.parse(body), jsonPath);
        jsonOk = jsonValue !== undefined && String(jsonValue) === jsonWant;
      } catch { jsonOk = false; jsonValue = null; }
    }
    return {
      determinate: true,
      ok: statusOk && markerOk && hdrOk && jsonOk,
      status: res.status, statusOk, markerOk, hdrOk, jsonOk,
      jsonValue: expectJson ? (jsonValue === undefined ? null : jsonValue) : undefined,
      headerValue: expectHeader ? (res.headers.get(hdrName) || null) : undefined,
      bodySnippet: body.slice(0, 200),
    };
  } catch (e) {
    // No determinate answer this attempt (network error, timeout/abort, DNS, TLS, etc).
    return { determinate: false, ok: false, error: String((e && e.message) || e) };
  } finally { clearTimeout(t); }
}

async function main() {
  if (configErrors.length) {
    // A config error is a REFUSE, not a healthy default and not silently a regression — the caller
    // must still treat it as "block promotion", and it is emitted with state:'refuse' so it never
    // gets read as `.healthy // false` == a proven-bad build.
    const reason = configErrors.join('; ');
    log(`❌ ${reason}`);
    emit({ healthy: false, state: 'refuse', reason });
    return 2;
  }

  let last = null;
  let lastDeterminate = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await probeOnce();
    if (last.determinate) {
      lastDeterminate = last;
      log(`probe ${attempt}/${maxAttempts} → status=${last.status} statusOk=${last.statusOk} markerOk=${last.markerOk} hdrOk=${last.hdrOk} jsonOk=${last.jsonOk}${last.redirectRejected ? ` redirectRejected=${last.redirectRejected}` : ''}`);
      if (last.ok) {
        emit({ healthy: true, state: 'healthy', url: target.href, attempts: attempt, ...last });
        log('✅ canary healthy — deploy proven live');
        return 0;
      }
    } else {
      log(`probe ${attempt}/${maxAttempts} → error: ${last.error}`);
    }
    if (attempt < maxAttempts) await sleep(retryDelay);
  }
  if (lastDeterminate) {
    // At least one attempt got a real HTTP answer and it never satisfied the criteria — this is a
    // proven regression, not an unknown. Spread the last DETERMINATE attempt, not simply the last
    // attempt: if a determinate failure is followed by a timeout, spreading `last` would emit a
    // `state:'regressed'` receipt whose body said `determinate:false` with no status/markerOk —
    // a receipt that contradicts its own verdict and misleads the operator reading it.
    emit({ healthy: false, state: 'regressed', url: target.href, attempts: maxAttempts, reason: 'canary never satisfied acceptance criteria', ...lastDeterminate });
    log('🛑 canary REGRESSED after all attempts — caller must ROLLBACK');
    return 1;
  }
  // No attempt ever produced a determinate HTTP response — this is NOT proof the deploy is bad,
  // but it is also NOT proof it is healthy. Fail closed: refuse, and the caller must treat refuse
  // exactly like regressed for promotion/rollback purposes (never fail-open on silence).
  emit({ healthy: false, state: 'refuse', url: target.href, attempts: maxAttempts, reason: 'no attempt produced a determinate HTTP response (network/timeout on every attempt) — cannot evaluate, refusing to call this healthy', ...last });
  log('⚠️  canary REFUSED TO EVALUATE — no determinate answer after all attempts — caller must ROLLBACK (fail-closed, not fail-open)');
  return 3;
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => {
    // Even an unexpected crash must leave a parseable fail-closed receipt on stdout: the wrapper
    // reads an empty/unparseable receipt as `refuse`, but an explicit one names the cause.
    log(`❌ probe crashed: ${String((err && err.stack) || err)}`);
    emit({ healthy: false, state: 'refuse', reason: `probe crashed: ${String((err && err.message) || err)}` });
    process.exitCode = 2;
  },
);
