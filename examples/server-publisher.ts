/**
 * Minimal MoQ publisher (and verification subscriber) for the WAVE MoQ edge relay.
 *
 * Zero dependencies. Node 22+, run with the built-in TypeScript type stripper:
 *
 *   node --experimental-strip-types examples/server-publisher.ts publish  --ns demo --track hello
 *   node --experimental-strip-types examples/server-publisher.ts subscribe --ns demo --track hello
 *
 * TRANSPORT — read this before you wonder where WebTransport went. IETF MoQ Transport runs over
 * WebTransport/QUIC, but Cloudflare Workers has no WebTransport *server* API, so this relay binds MoQ
 * to a WebSocket (see src/moq-wire.ts). Control and data share one message-oriented socket, so every
 * frame carries a 1-byte kind tag (0x00 = control, 0x01 = object). Strip that byte and the body is
 * exact draft-ietf-moq-transport-18. The tag disappears the day a WebTransport server binding lands.
 *
 * AUTH — the production relay runs with MOQ_JOIN_ENFORCE=enforce: it accepts only a short-lived
 * HMAC join token minted by the WAVE gateway, bound to this namespace/track and scope. So:
 *
 *   export WAVE_API_KEY=...        # your WAVE API key — read from env, never printed, never stored
 *   node --experimental-strip-types examples/server-publisher.ts publish --ns demo --track hello
 *
 * mints a join token via POST https://api.wave.online/v1/moq/publish/:ns/:track and dials the relay
 * with `?join=<token>`. If you already have a token, pass `--join <token>` (or set WAVE_MOQ_JOIN) and
 * no key is needed. Against a local `wrangler dev` (where join enforcement is off) neither is needed.
 *
 * WIRE CODEC — this file carries its own ~130-line publisher-side subset of the draft-18 codec so it
 * stays single-file and zero-dep. `src/moq-wire.ts` is the canonical, unit-tested implementation;
 * `examples/interop-test.sh` is what pins this subset to it, by running a real round trip.
 *
 * FRAME ENVELOPE — see examples/moq-demo-frame.md. Not part of MoQ; the relay never reads it.
 */

// ── draft-18 wire subset (§1.4.1 varint, §10 control framing, §11 object model) ───────────────────

const MOQ_MSG = { SETUP: 0x2f00, SUBSCRIBE: 0x3, SUBSCRIBE_OK: 0x4, REQUEST_ERROR: 0x5, PUBLISH_NAMESPACE: 0x6, REQUEST_OK: 0x7 } as const;
const MOQ_ROLE = { PUBLISHER: 0, SUBSCRIBER: 1 } as const;
const WS_KIND = { CONTROL: 0x00, OBJECT: 0x01 } as const;
const STATUS_NORMAL = 0x0;

/** Growable byte writer with the draft-18 §1.4.1 leading-1-bits varint (NOT RFC 9000's 2-bit form). */
class Writer {
  private buf: number[] = [];
  bytes(): Uint8Array { return new Uint8Array(this.buf); }
  u8(v: number): this { this.buf.push(v & 0xff); return this; }
  u16(v: number): this { this.buf.push((v >> 8) & 0xff, v & 0xff); return this; }
  raw(b: Uint8Array): this { for (const x of b) this.buf.push(x); return this; }
  varint(value: number | bigint): this {
    const v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
    if (v < 0n) throw new RangeError('varint must be non-negative');
    let n = 9;
    for (let k = 1; k <= 8; k++) if (v < 1n << BigInt(7 * k)) { n = k; break; }
    const out = new Uint8Array(n);
    let tmp = v;
    for (let i = n - 1; i >= 0; i--) { out[i] = Number(tmp & 0xffn); tmp >>= 8n; }
    if (n <= 8) out[0] |= (0xff << (9 - n)) & 0xff; else out[0] = 0xff;
    return this.raw(out);
  }
  bytesLP(b: Uint8Array): this { return this.varint(b.length).raw(b); }
  strLP(s: string): this { return this.bytesLP(new TextEncoder().encode(s)); }
  /** Track Namespace tuple (§1.4.2): count(i) + N length-prefixed fields. */
  tuple(fields: string[]): this { this.varint(fields.length); for (const f of fields) this.strLP(f); return this; }
}

class Reader {
  private pos = 0;
  private readonly b: Uint8Array;
  // NOTE: a plain field assignment, not a TypeScript parameter property — `node
  // --experimental-strip-types` only ERASES types, it cannot synthesise the field a parameter
  // property would need. Keeping to erasable syntax is what makes this file runnable with no build.
  constructor(b: Uint8Array) { this.b = b; }
  get remaining(): number { return this.b.length - this.pos; }
  u8(): number { if (this.pos >= this.b.length) throw new RangeError('read past end'); return this.b[this.pos++]; }
  u16(): number { return (this.u8() << 8) | this.u8(); }
  raw(len: number): Uint8Array {
    if (this.pos + len > this.b.length) throw new RangeError('read past end');
    const out = this.b.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  varint(): bigint {
    const b0 = this.u8();
    let lead = 0, probe = b0;
    while (lead < 8 && probe & 0x80) { lead++; probe = (probe << 1) & 0xff; }
    if (lead === 8) { let v = 0n; for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(this.u8()); return v; }
    const n = lead + 1;
    let v = BigInt(b0 & (0xff >> n));
    for (let i = 1; i < n; i++) v = (v << 8n) | BigInt(this.u8());
    return v;
  }
  varintNum(): number { return Number(this.varint()); }
  bytesLP(): Uint8Array { return this.raw(this.varintNum()); }
}

/** Control framing (§10): Type(i) + Length(16) + Payload. */
const frameControl = (type: number, payload: Uint8Array): Uint8Array =>
  new Writer().varint(type).u16(payload.length).raw(payload).bytes();
const parseControl = (bytes: Uint8Array): { type: number; payload: Uint8Array } => {
  const r = new Reader(bytes);
  const type = r.varintNum();
  const len = r.u16();
  return { type, payload: r.raw(len) };
};

const encodeSetup = (role: number): Uint8Array =>
  frameControl(MOQ_MSG.SETUP, new Writer().varint(role).varint(0xffffn).varint(0).bytes());
const encodePublishNamespace = (requestId: bigint, ns: string[]): Uint8Array =>
  frameControl(MOQ_MSG.PUBLISH_NAMESPACE, new Writer().varint(requestId).tuple(ns).varint(0).bytes());
const encodeSubscribe = (requestId: bigint, ns: string[], trackName: string): Uint8Array =>
  frameControl(MOQ_MSG.SUBSCRIBE, new Writer().varint(requestId).tuple(ns).strLP(trackName).bytes());

/** OBJECT_DATAGRAM (§11.3.1): TrackAlias(i) GroupId(i) ObjectId(i) Status(i) PayloadLen(i) Payload. */
const encodeObject = (trackAlias: bigint, groupId: bigint, objectId: bigint, payload: Uint8Array): Uint8Array =>
  new Writer().varint(trackAlias).varint(groupId).varint(objectId).varint(STATUS_NORMAL).bytesLP(payload).bytes();
const decodeObject = (bytes: Uint8Array) => {
  const r = new Reader(bytes);
  return { trackAlias: r.varint(), groupId: r.varint(), objectId: r.varint(), status: r.varintNum(), payload: r.bytesLP() };
};

/** WebSocket envelope: 1 kind byte + exact draft-18 body. The only non-spec byte on the wire. */
const tagFrame = (kind: number, body: Uint8Array): Uint8Array => {
  const out = new Uint8Array(body.length + 1);
  out[0] = kind;
  out.set(body, 1);
  return out;
};
const untagFrame = (bytes: Uint8Array) => ({ kind: bytes[0], body: bytes.subarray(1) });

// ── wave-demo/1 frame envelope (examples only — see examples/moq-demo-frame.md) ───────────────────

const DEMO_MAGIC = 0x57; // 'W'
const DEMO_VERSION = 1;
const DEMO_KIND = { RGBA: 1, H264: 2 } as const;
const DEMO_HEADER_BYTES = 16;

function encodeDemoFrame(kind: number, keyframe: boolean, width: number, height: number, media: Uint8Array): Uint8Array {
  const out = new Uint8Array(DEMO_HEADER_BYTES + media.length);
  const dv = new DataView(out.buffer);
  out[0] = DEMO_MAGIC;
  out[1] = DEMO_VERSION;
  out[2] = kind;
  out[3] = keyframe ? 1 : 0;
  dv.setFloat64(4, Date.now(), true);
  dv.setUint16(12, width, true);
  dv.setUint16(14, height, true);
  out.set(media, DEMO_HEADER_BYTES);
  return out;
}

function decodeDemoFrame(bytes: Uint8Array): { kind: number; keyframe: boolean; captureMs: number; width: number; height: number; media: Uint8Array } | null {
  if (bytes.length < DEMO_HEADER_BYTES || bytes[0] !== DEMO_MAGIC || bytes[1] !== DEMO_VERSION) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    kind: bytes[2],
    keyframe: (bytes[3] & 1) === 1,
    captureMs: dv.getFloat64(4, true),
    width: dv.getUint16(12, true),
    height: dv.getUint16(14, true),
    media: bytes.subarray(DEMO_HEADER_BYTES),
  };
}

// ── test-pattern source: moving bars + a sweeping bright band, so motion is obvious on screen ─────

function renderTestPattern(width: number, height: number, frameIndex: number): Uint8Array {
  const px = new Uint8Array(width * height * 4);
  const sweep = Math.floor(((frameIndex * 3) % (width + 60)) - 30);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const band = Math.floor(((x + frameIndex * 2) / Math.max(1, width / 8)) % 8);
      px[i] = band & 1 ? 220 : 20;
      px[i + 1] = band & 2 ? 200 : 25;
      px[i + 2] = band & 4 ? 210 : 30;
      const d = Math.abs(x - sweep);
      if (d < 8) { const k = (8 - d) * 28; px[i] = Math.min(255, px[i] + k); px[i + 1] = Math.min(255, px[i + 1] + k); px[i + 2] = Math.min(255, px[i + 2] + k); }
      if (y < 4 || y >= height - 4) { px[i] = 0; px[i + 1] = 212; px[i + 2] = 213; } // WAVE accent border
      px[i + 3] = 255;
    }
  }
  return px;
}

/** Split an H.264 Annex-B elementary stream into access units (split at each AUD/SPS/first-slice start). */
function splitAnnexB(buf: Uint8Array): Array<{ bytes: Uint8Array; keyframe: boolean }> {
  const starts: number[] = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) starts.push(i > 0 && buf[i - 1] === 0 ? i - 1 : i);
    else if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) starts.push(i);
  }
  const units: Array<{ bytes: Uint8Array; keyframe: boolean }> = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const e = k + 1 < starts.length ? starts[k + 1] : buf.length;
    if (e <= s) continue;
    const scLen = buf[s] === 0 && buf[s + 1] === 0 && buf[s + 2] === 1 ? 3 : 4;
    const nalType = buf[s + scLen] & 0x1f;
    if (nalType === 9) continue; // access unit delimiter — carried with the next unit
    const isVcl = nalType === 1 || nalType === 5;
    const isParam = nalType === 7 || nalType === 8;
    const unit = { bytes: buf.subarray(s, e), keyframe: nalType === 5 || isParam };
    // Accumulate SPS/PPS onto the following IDR so a decoder can start from any keyframe object.
    if (isParam && k + 1 < starts.length) { units.push(unit); continue; }
    if (isVcl || isParam) units.push(unit);
  }
  return units;
}

// ── gateway join-token mint ───────────────────────────────────────────────────────────────────────

/**
 * Ask the WAVE gateway to authorize this caller for ns/track and mint a short-lived join token.
 * The API key is read from the environment and is never logged, echoed, or written to disk.
 */
async function mintJoinToken(gateway: string, role: 'publish' | 'subscribe', ns: string, track: string, apiKey: string): Promise<string> {
  const url = `${gateway.replace(/\/$/, '')}/v1/moq/${role}/${encodeURIComponent(ns)}/${encodeURIComponent(track)}`;
  const attempts: Array<'POST' | 'GET'> = role === 'publish' ? ['POST', 'GET'] : ['GET', 'POST'];
  let lastDetail = '';
  for (const method of attempts) {
    const res = await fetch(url, { method, headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' } });
    const body = await res.text();
    if (res.ok) {
      let json: Record<string, unknown>;
      try { json = JSON.parse(body) as Record<string, unknown>; } catch { throw new Error(`mint ${method} ${url} returned ${res.status} with a non-JSON body`); }
      const token = (json.joinToken ?? json.join_token ?? json.token ?? json.join) as string | undefined;
      if (!token) throw new Error(`mint ${method} ${url} returned ${res.status} but no joinToken field (keys: ${Object.keys(json).join(', ')})`);
      return token;
    }
    lastDetail = `${method} ${url} → ${res.status} ${res.statusText}: ${body.slice(0, 300)}`;
    if (res.status !== 404 && res.status !== 405) break; // only a routing miss is worth retrying with the other verb
  }
  throw new Error(
    `could not mint a MoQ join token.\n  ${lastDetail}\n` +
    `  401/403 → the key lacks moq:write/moq:read for this namespace.\n` +
    `  402     → the account has no MoQ entitlement.\n` +
    `  Or pass an already-minted token with --join <token> (env WAVE_MOQ_JOIN).`
  );
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

interface Opts {
  cmd: 'publish' | 'subscribe';
  relay: string;
  gateway: string;
  ns: string;
  track: string;
  fps: number;
  seconds: number;
  width: number;
  height: number;
  file: string | null;
  join: string | null;
  json: boolean;
}

function parseArgs(argv: string[]): Opts {
  const cmd = (argv[0] === 'subscribe' ? 'subscribe' : 'publish') as Opts['cmd'];
  const rest = argv[0] === 'publish' || argv[0] === 'subscribe' ? argv.slice(1) : argv;
  const flag = (name: string): string | null => {
    const i = rest.indexOf(`--${name}`);
    if (i >= 0 && rest[i + 1] !== undefined) return rest[i + 1];
    const eq = rest.find((a) => a.startsWith(`--${name}=`));
    return eq ? eq.slice(name.length + 3) : null;
  };
  const num = (name: string, dflt: number): number => {
    const v = flag(name);
    return v === null ? dflt : Number(v);
  };
  return {
    cmd,
    relay: flag('relay') ?? process.env.WAVE_MOQ_RELAY ?? 'wss://moq.wave.online',
    gateway: flag('gateway') ?? process.env.WAVE_GATEWAY ?? 'https://api.wave.online',
    ns: flag('ns') ?? 'demo',
    track: flag('track') ?? 'hello',
    fps: num('fps', 15),
    seconds: num('seconds', 0),
    width: num('width', 160),
    height: num('height', 90),
    file: flag('file'),
    join: flag('join') ?? process.env.WAVE_MOQ_JOIN ?? null,
    json: rest.includes('--json'),
  };
}

async function resolveJoin(o: Opts, role: 'publish' | 'subscribe'): Promise<string | null> {
  if (o.join) return o.join;
  const key = process.env.WAVE_API_KEY;
  if (!key) {
    // No token and no key. Fine against a local relay with join enforcement off; the relay will
    // answer 401 otherwise and we surface that verbatim.
    log(`no --join token and no WAVE_API_KEY — dialing unauthenticated (works only where MOQ_JOIN_ENFORCE is off)`);
    return null;
  }
  log(`minting a ${role} join token via ${o.gateway} …`);
  const t = await mintJoinToken(o.gateway, role, o.ns, o.track, key);
  log(`join token minted (${t.length} chars, not shown)`);
  return t;
}

function socketUrl(o: Opts, role: 'publish' | 'subscribe', join: string | null): string {
  const base = o.relay.replace(/\/$/, '').replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  const u = new URL(`${base}/v1/${role}/${encodeURIComponent(o.ns)}/${encodeURIComponent(o.track)}`);
  if (join) u.searchParams.set('join', join);
  return u.toString();
}

const log = (msg: string): void => { process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`); };

/** Redact any `join=` token before a URL is printed. */
const safeUrl = (u: string): string => u.replace(/join=[^&]*/, 'join=<redacted>');

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error(`WebSocket failed to open: ${safeUrl(url)} (a 401/403 here means the join token was rejected)`)), { once: true });
  });
}

// ── publish ───────────────────────────────────────────────────────────────────────────────────────

async function runPublish(o: Opts): Promise<number> {
  const join = await resolveJoin(o, 'publish');
  const url = socketUrl(o, 'publish', join);
  log(`connecting publisher → ${safeUrl(url)}`);
  const ws = await openSocket(url);
  log('connected; sending SETUP + PUBLISH_NAMESPACE');

  let requestOk = false;
  ws.addEventListener('message', (ev: MessageEvent) => {
    const { kind, body } = untagFrame(new Uint8Array(ev.data as ArrayBuffer));
    if (kind !== WS_KIND.CONTROL) return;
    const { type } = parseControl(body);
    if (type === MOQ_MSG.REQUEST_OK) { requestOk = true; log('relay accepted the namespace (REQUEST_OK)'); }
    if (type === MOQ_MSG.REQUEST_ERROR) log('relay returned REQUEST_ERROR');
  });

  ws.send(tagFrame(WS_KIND.CONTROL, encodeSetup(MOQ_ROLE.PUBLISHER)));
  ws.send(tagFrame(WS_KIND.CONTROL, encodePublishNamespace(1n, [o.ns])));

  // Source: an H.264 elementary stream if --file was given, else the generated RGBA test pattern.
  let annexb: Array<{ bytes: Uint8Array; keyframe: boolean }> | null = null;
  if (o.file) {
    const { readFile } = await import('node:fs/promises');
    annexb = splitAnnexB(new Uint8Array(await readFile(o.file)));
    log(`loaded ${o.file}: ${annexb.length} H.264 access units`);
    if (annexb.length === 0) return fail('no H.264 access units found — is that an Annex-B elementary stream?');
  } else {
    log(`generating a ${o.width}x${o.height} RGBA test pattern at ${o.fps} fps (no encoder, no dependencies)`);
  }

  const trackAlias = 1n;
  let group = 0n, objectId = 0n, frame = 0, sent = 0, bytes = 0;
  const started = Date.now();
  const period = 1000 / Math.max(1, o.fps);

  const stop = new Promise<void>((resolve) => {
    ws.addEventListener('close', () => { log('socket closed by the relay'); resolve(); }, { once: true });
    process.on('SIGINT', () => { log('SIGINT — closing'); try { ws.close(); } catch { /* already closed */ } resolve(); });
    if (o.seconds > 0) setTimeout(() => { try { ws.close(); } catch { /* already closed */ } resolve(); }, o.seconds * 1000);
  });

  const timer = setInterval(() => {
    if (ws.readyState !== 1) return;
    let payload: Uint8Array;
    let keyframe: boolean;
    if (annexb) {
      const au = annexb[frame % annexb.length];
      keyframe = au.keyframe;
      payload = encodeDemoFrame(DEMO_KIND.H264, keyframe, o.width, o.height, au.bytes);
    } else {
      keyframe = frame % o.fps === 0; // one group per second of test pattern
      payload = encodeDemoFrame(DEMO_KIND.RGBA, keyframe, o.width, o.height, renderTestPattern(o.width, o.height, frame));
    }
    if (keyframe && frame > 0) { group += 1n; objectId = 0n; }
    ws.send(tagFrame(WS_KIND.OBJECT, encodeObject(trackAlias, group, objectId, payload)));
    objectId += 1n;
    frame += 1;
    sent += 1;
    bytes += payload.length;
    if (sent % (o.fps * 5) === 0) {
      const secs = (Date.now() - started) / 1000;
      log(`published ${sent} objects · group ${group} · ${(bytes / 1024 / secs).toFixed(0)} KiB/s`);
    }
  }, period);

  await stop;
  clearInterval(timer);
  const secs = (Date.now() - started) / 1000;
  log(`done: ${sent} objects in ${secs.toFixed(1)}s (namespace ack: ${requestOk})`);
  if (o.json) process.stdout.write(JSON.stringify({ role: 'publish', objects: sent, seconds: Number(secs.toFixed(2)), namespace_ack: requestOk }) + '\n');
  return sent > 0 && requestOk ? 0 : 1;
}

// ── subscribe (the verification half used by interop-test.sh) ─────────────────────────────────────

async function runSubscribe(o: Opts): Promise<number> {
  const join = await resolveJoin(o, 'subscribe');
  const url = socketUrl(o, 'subscribe', join);
  log(`connecting subscriber → ${safeUrl(url)}`);
  const ws = await openSocket(url);
  log('connected; sending SETUP + SUBSCRIBE');

  const latencies: number[] = [];
  let subscribeOk = false, objects = 0, bytes = 0, keyframes = 0, badEnvelope = 0, replayed = 0;
  // The relay hands a late joiner its cached recent groups (MOQ_CACHED_GROUPS) so decoding can start
  // at a group boundary. Those objects were captured BEFORE we subscribed, so their "latency" is
  // really cache age — counting them would inflate p95 by seconds. They are counted separately.
  const subscribedAt = Date.now();

  ws.addEventListener('message', (ev: MessageEvent) => {
    const { kind, body } = untagFrame(new Uint8Array(ev.data as ArrayBuffer));
    if (kind === WS_KIND.CONTROL) {
      const { type } = parseControl(body);
      if (type === MOQ_MSG.SUBSCRIBE_OK) { subscribeOk = true; log('relay accepted the subscription (SUBSCRIBE_OK)'); }
      if (type === MOQ_MSG.REQUEST_ERROR) log('relay returned REQUEST_ERROR');
      return;
    }
    const obj = decodeObject(body);
    const demo = decodeDemoFrame(obj.payload);
    objects += 1;
    bytes += obj.payload.length;
    if (!demo) { badEnvelope += 1; return; }
    if (demo.keyframe) keyframes += 1;
    if (demo.captureMs < subscribedAt) { replayed += 1; return; } // cache replay — not a latency sample
    latencies.push(Date.now() - demo.captureMs);
  });

  ws.send(tagFrame(WS_KIND.CONTROL, encodeSetup(MOQ_ROLE.SUBSCRIBER)));
  ws.send(tagFrame(WS_KIND.CONTROL, encodeSubscribe(1n, [o.ns], o.track)));

  await new Promise<void>((resolve) => {
    ws.addEventListener('close', () => resolve(), { once: true });
    process.on('SIGINT', () => { try { ws.close(); } catch { /* already closed */ } resolve(); });
    setTimeout(() => { try { ws.close(); } catch { /* already closed */ } resolve(); }, Math.max(1, o.seconds || 10) * 1000);
  });

  const pct = (p: number): number | null => {
    if (latencies.length === 0) return null;
    const s = [...latencies].sort((a, b) => a - b);
    return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
  };
  const result = {
    role: 'subscribe' as const,
    subscribe_ok: subscribeOk,
    objects,
    keyframes,
    bytes,
    bad_envelope: badEnvelope,
    replayed_from_cache: replayed,
    latency_samples: latencies.length,
    p50_ms: pct(50),
    p95_ms: pct(95),
    // Latency is publisher-clock to subscriber-clock. Meaningful on one machine (interop-test.sh),
    // approximate across NTP-synced hosts, meaningless across skewed ones. Objects replayed from the
    // relay's late-joiner cache are excluded — their age is cache depth, not transport latency.
    latency_basis: 'publisher Date.now() → subscriber Date.now(), live objects only',
  };
  log(`received ${objects} objects (${keyframes} keyframes, ${replayed} replayed from cache), p50 ${result.p50_ms ?? '—'} ms, p95 ${result.p95_ms ?? '—'} ms`);
  process.stdout.write(JSON.stringify(result) + '\n');
  return subscribeOk && objects > 0 ? 0 : 1;
}

function fail(msg: string): number {
  log(`FAILED: ${msg}`);
  return 1;
}

// No top-level await and no top-level import/export: this file is "erasable syntax" only, so
// `node --experimental-strip-types examples/server-publisher.ts` runs it with zero build step
// regardless of whether the package is CommonJS or ESM.
async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  try {
    process.exitCode = opts.cmd === 'subscribe' ? await runSubscribe(opts) : await runPublish(opts);
  } catch (err) {
    process.exitCode = fail(err instanceof Error ? err.message : String(err));
  }
}
void main();
