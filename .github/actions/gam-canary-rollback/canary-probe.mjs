#!/usr/bin/env node
// GAM deploy-bound lever — CANARY PROBE (the L3 progressive-delivery gate), 3-STATE VERSION.
//
// After a deploy, this probes the freshly-deployed surface and decides whether the deploy is
// HEALTHY, REGRESSED, or the probe must REFUSE-TO-EVALUATE. A bare HTTP 200 is NOT proof (a
// holding page, a stale worker, a shadowed route all 200) — so the probe REQUIRES a content
// marker (and optionally a response header/status) that only the RIGHT, current build serves.
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
//               of a bad build: wrong marker, wrong status, wrong header).
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
// Env (all optional except URL + one marker):
//   CANARY_URL         (required) URL to probe.
//   CANARY_METHOD      HTTP method (default GET).
//   CANARY_BODY        request body (for POST/PUT).
//   CANARY_HEADERS     JSON object of request headers.
//   EXPECT_MARKER      substring that MUST appear in the response body (the "right build" proof).
//   EXPECT_HEADER      "Name: value-substr" that MUST appear in a response header (e.g. a version/etag).
//   EXPECT_STATUS      expected HTTP status (default: any 2xx).
//   MAX_ATTEMPTS       retries before declaring a verdict (default 6 — a fresh deploy may warm slowly).
//   RETRY_DELAY_MS     delay between attempts (default 10000).
//   TIMEOUT_MS         per-request timeout (default 15000).
//
// Exit: 0 = healthy (deploy PROVEN live) · 1 = regressed (caller should ROLLBACK)
//       · 2 = usage/config error (REFUSE — nothing was probed) · 3 = refuse (probed, but every
//       attempt failed to produce a determinate answer — caller should ROLLBACK, same as regressed)
// Emits a JSON receipt to stdout on the last line (parse with `tail -1`), human lines to stderr.

const env = process.env;
const url = env.CANARY_URL;
const method = (env.CANARY_METHOD || 'GET').toUpperCase();
const expectMarker = env.EXPECT_MARKER || '';
const expectHeader = env.EXPECT_HEADER || '';
const expectStatus = env.EXPECT_STATUS ? Number(env.EXPECT_STATUS) : null;
const maxAttempts = Math.max(1, Number(env.MAX_ATTEMPTS || 6));
const retryDelay = Math.max(0, Number(env.RETRY_DELAY_MS || 10000));
const timeoutMs = Math.max(1000, Number(env.TIMEOUT_MS || 15000));

const log = (m) => process.stderr.write(m + '\n');
const emit = (rec) => process.stdout.write(JSON.stringify(rec) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A config error is a REFUSE, not a healthy default and not silently a regression — the caller
// must still treat it as "block promotion", and it is emitted with state:'refuse' so it never
// gets read as `.healthy // false` == a proven-bad build.
function refuseConfig(reason) {
  log(`❌ ${reason}`);
  emit({ healthy: false, state: 'refuse', reason });
  process.exit(2);
}

if (!url) refuseConfig('CANARY_URL is required');
if (!expectMarker && !expectHeader && expectStatus === null) {
  refuseConfig('need at least one of EXPECT_MARKER / EXPECT_HEADER / EXPECT_STATUS — a bare fetch is not proof');
}
// A non-empty EXPECT_STATUS that isn't a number would silently never match → a spurious rollback
// on every deploy. Reject it as a config error instead (fail-closed on misconfiguration).
if (expectStatus !== null && !Number.isFinite(expectStatus)) {
  refuseConfig(`EXPECT_STATUS='${env.EXPECT_STATUS}' is not a number`);
}

let headers = {};
if (env.CANARY_HEADERS) {
  try { headers = JSON.parse(env.CANARY_HEADERS); }
  catch { refuseConfig('CANARY_HEADERS is not valid JSON'); }
}

// Parse "Name: substr" once.
let hdrName = '', hdrWant = '';
if (expectHeader) {
  const i = expectHeader.indexOf(':');
  if (i < 0) refuseConfig('EXPECT_HEADER must be "Name: value-substr"');
  hdrName = expectHeader.slice(0, i).trim().toLowerCase();
  hdrWant = expectHeader.slice(i + 1).trim();
}

async function probeOnce() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: (method === 'GET' || method === 'HEAD') ? undefined : (env.CANARY_BODY || undefined),
      signal: ctrl.signal,
      // Follow redirects and validate the FINAL response — a normal https/trailing-slash
      // canonicalization 3xx must not be read as a regression and trigger a spurious rollback.
      redirect: 'follow',
    });
    const body = await res.text();
    const statusOk = expectStatus !== null ? res.status === expectStatus : (res.status >= 200 && res.status < 300);
    const markerOk = expectMarker ? body.includes(expectMarker) : true;
    const hdrOk = expectHeader ? ((res.headers.get(hdrName) || '').includes(hdrWant)) : true;
    // A determinate answer was obtained — healthy or regressed, never refuse from here on.
    return {
      determinate: true,
      ok: statusOk && markerOk && hdrOk,
      status: res.status, statusOk, markerOk, hdrOk,
      headerValue: expectHeader ? (res.headers.get(hdrName) || null) : undefined,
      bodySnippet: body.slice(0, 200),
    };
  } catch (e) {
    // No determinate answer this attempt (network error, timeout/abort, DNS, TLS, etc).
    return { determinate: false, ok: false, error: String((e && e.message) || e) };
  } finally { clearTimeout(t); }
}

(async () => {
  let last = null;
  let sawDeterminate = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await probeOnce();
    if (last.determinate) {
      sawDeterminate = true;
      log(`probe ${attempt}/${maxAttempts} → status=${last.status} statusOk=${last.statusOk} markerOk=${last.markerOk} hdrOk=${last.hdrOk}`);
      if (last.ok) {
        emit({ healthy: true, state: 'healthy', url, attempts: attempt, ...last });
        log('✅ canary healthy — deploy proven live');
        process.exit(0);
      }
    } else {
      log(`probe ${attempt}/${maxAttempts} → error: ${last.error}`);
    }
    if (attempt < maxAttempts) await sleep(retryDelay);
  }
  if (sawDeterminate) {
    // At least one attempt got a real HTTP answer and it never satisfied the criteria — this is a
    // proven regression, not an unknown.
    emit({ healthy: false, state: 'regressed', url, attempts: maxAttempts, reason: 'canary never satisfied acceptance criteria', ...last });
    log('🛑 canary REGRESSED after all attempts — caller must ROLLBACK');
    process.exit(1);
  }
  // No attempt ever produced a determinate HTTP response — this is NOT proof the deploy is bad,
  // but it is also NOT proof it is healthy. Fail closed: refuse, and the caller must treat refuse
  // exactly like regressed for promotion/rollback purposes (never fail-open on silence).
  emit({ healthy: false, state: 'refuse', url, attempts: maxAttempts, reason: 'no attempt produced a determinate HTTP response (network/timeout on every attempt) — cannot evaluate, refusing to call this healthy', ...last });
  log('⚠️  canary REFUSED TO EVALUATE — no determinate answer after all attempts — caller must ROLLBACK (fail-closed, not fail-open)');
  process.exit(3);
})();
