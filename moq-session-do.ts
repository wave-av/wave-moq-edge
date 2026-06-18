/// <reference types="@cloudflare/workers-types" />
/**
 * MoQ Session Durable Object — the per-track rendezvous + fan-out relay (draft-18).
 *
 * One instance per `namespace/track` (the Worker keys it with idFromName(trackKey)). Publisher and
 * all subscribers connect to THIS object; it relays objects from the publisher to every subscriber
 * and meters the traffic into the canonical R4 `wave.usage` shape.
 *
 * TRANSPORT: a WebSocket today. The relay's wire codec (src/moq-wire.ts) is exact draft-18 and
 * transport-independent; CF Workers has no WebTransport *server* API yet (no `acceptWebTransport`,
 * no compat flag as of compat-date 2026-01-01), so we bind to a WebSocket and carry each MoQ frame
 * with a 1-byte kind tag (src/moq-wire.ts WS_KIND). When CF ships WebTransport server, control maps
 * to the control stream and objects to datagrams with NO codec/relay change.
 *
 * HIBERNATION-SURVIVAL: we use the hibernation API (`state.acceptWebSocket()` + the webSocketMessage/
 * Close/Error handler methods), so CF may evict the DO from memory while sockets stay open and
 * reconstruct it on the next event. Each socket carries a small survival attachment ({sessionId, role})
 * via serializeAttachment; on the first event after a wake, ensureRehydrated() walks getWebSockets(),
 * rebuilds the sessionId↔socket maps, and replays publisher/subscriber registration into the relay
 * (MoqRelay.hydrate) so fan-out resumes without a re-handshake. The late-joiner object cache is
 * best-effort and intentionally not persisted (it refills as new groups arrive).
 *
 * The legacy JSON endpoints (/state, POST register, GET subscribe-register) are preserved so the
 * Worker's metadata routes and any HTTP client keep working alongside the new WS relay path.
 */
import { MoqRelay, type RelayEvent } from './src/moq-relay';
import { WS_KIND, tagFrame, untagFrame } from './src/moq-wire';
import { MetricsCollector } from './metrics-collector';
import { emitMoqUsage } from './usage-emit';
import { emitMoqSessionSpan, type MoqObsEnv } from './telemetry';
import { SessionRecorder, type RecorderMeta } from './recording-writer';
import { registerRecording } from './register-recording';

interface Env extends MoqObsEnv {
  MOQ_TRACK_REGISTRY: KVNamespace;
  MOQ_RECORDINGS: R2Bucket;
  ENVIRONMENT: string;
  MOQ_DRAFT_VERSION: string;
  MAX_SUBSCRIBERS_PER_TRACK: string;
  MAX_OBJECT_SIZE_BYTES: string;
  LOG_LEVEL: string;
  MOQ_CACHED_GROUPS?: string; // late-joiner cache depth (default 3)
  // #284 usage emit (both optional → emit is INERT until an operator provisions them; see usage-emit.ts):
  GATEWAY_BASE_URL?: string; //   gateway origin for POST /v1/internal/usage + /recordings/register (var)
  WAVE_SERVICE_TOKEN?: string; // internal service bearer for the ingest + register endpoints (secret)
  // Recording write path (recording-writer.ts / register-recording.ts). The bucket NAME (the R2 binding
  // doesn't expose it) sent to the gateway register. Unset → recording is INERT (no behavior change).
  MOQ_RECORDINGS_BUCKET?: string;
  // Telemetry (B.4): optional OTLP/Sentry bindings via MoqObsEnv — DEFAULT-OFF, operator-supplied.
}

/** What survives hibernation, pinned to each socket via serializeAttachment (≤2KB structured clone). */
interface SocketAttachment {
  sessionId: string;
  role: 'pending' | 'publisher' | 'subscriber';
  org?: string; // #284: gateway-injected x-wave-org captured at upgrade, so a hibernation wake keeps it
}

interface SessionState {
  trackKey: string;
  publisherSessionId: string | null;
  publisherOrg: string | null; // #284: the publisher's billing org (from x-wave-org); null = unattributed
  subscriberCount: number;
  publisherStartedAt: string | null;
  lastActivityAt: string | null;
  groupsSeen: number;
  objectsSeen: number;
}

export class MOQSessionDurableObject {
  private state: DurableObjectState;
  private env: Env;
  private session: SessionState | null = null;

  // Live relay + transport state. With the hibernation API the DO may be evicted from memory while
  // sockets stay open, so these maps are rebuilt lazily from getWebSockets() attachments on wake
  // (ensureRehydrated). The late-joiner cache is best-effort and not restored (see MoqRelay.hydrate).
  private relay: MoqRelay;
  private sockets = new Map<string, WebSocket>(); // sessionId → socket
  private socketIds = new WeakMap<WebSocket, string>();
  private sessionOrgs = new Map<string, string>(); // #284: sessionId → x-wave-org (rebuilt from attachments on wake)
  private rehydrated = false;
  private metrics: MetricsCollector;

  // Recording write path: one R2 multipart upload per publisher session (recording-writer.ts). Lazily
  // created on the first publisher object (so the container can be sniffed), and ONLY when recording is
  // provisioned (org + gateway + service token + bucket name) — otherwise fully inert. The multipart meta
  // is persisted to DO storage ('recorder' key) so a hibernation wake can resume + complete it.
  private recorder: SessionRecorder | null = null;
  private recorderLoaded = false; // whether we've checked storage for a resumable recorder this lifetime

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.metrics = new MetricsCollector(env);
    const cachedGroups = parseInt(env.MOQ_CACHED_GROUPS ?? '', 10);
    this.relay = new MoqRelay({ cachedGroups: Number.isFinite(cachedGroups) ? cachedGroups : undefined });
  }

  /**
   * Rebuild in-memory socket maps + relay registration from the sockets that survived a hibernation
   * wake. Idempotent (guarded by `rehydrated`); runs at the top of fetch() and every WS handler so the
   * first event after an eviction reconstructs state before it is used.
   */
  private ensureRehydrated(): void {
    if (this.rehydrated) return;
    this.rehydrated = true;
    const restored: Array<{ sessionId: string; role: 'publisher' | 'subscriber' }> = [];
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (!att?.sessionId) continue;
      this.sockets.set(att.sessionId, ws);
      this.socketIds.set(ws, att.sessionId);
      if (att.org) this.sessionOrgs.set(att.sessionId, att.org); // #284: keep the billing org across hibernation
      if (att.role === 'publisher' || att.role === 'subscriber') restored.push({ sessionId: att.sessionId, role: att.role });
    }
    if (restored.length) this.relay.hydrate(restored);
  }

  /** Persist a socket's learned role into its attachment so a hibernation wake can rebuild the relay. */
  private setRole(sessionId: string, role: 'publisher' | 'subscriber'): void {
    const ws = this.sockets.get(sessionId);
    // Preserve the captured org (#284) — re-serializing without it would drop the publisher's billing org.
    if (ws) ws.serializeAttachment({ sessionId, role, org: this.sessionOrgs.get(sessionId) } satisfies SocketAttachment);
  }

  private async load(): Promise<SessionState> {
    if (this.session) return this.session;
    const stored = await this.state.storage.get<SessionState>('session');
    if (stored) {
      this.session = stored;
      return stored;
    }
    const fresh: SessionState = {
      trackKey: this.state.id.toString(),
      publisherSessionId: null,
      publisherOrg: null,
      subscriberCount: 0,
      publisherStartedAt: null,
      lastActivityAt: null,
      groupsSeen: 0,
      objectsSeen: 0,
    };
    this.session = fresh;
    await this.state.storage.put('session', fresh);
    return fresh;
  }

  private async save(): Promise<void> {
    if (this.session) await this.state.storage.put('session', this.session);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.ensureRehydrated(); // a wake may deliver an upgrade/HTTP request before any WS event

    // WebSocket relay upgrade (publisher or subscriber). The path tells us the intended role, but
    // the authoritative role comes from the first control message (PUBLISH_NAMESPACE vs SUBSCRIBE).
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      // #284: capture the gateway-injected principal org so a publisher session can be billed at close.
      // Absent (anonymous / direct traffic) → null → usage emit is skipped (we never fabricate an org).
      const org = request.headers.get('x-wave-org')?.trim() || null;
      return this.handleWebSocket(url, org);
    }

    const session = await this.load();

    if (url.pathname === '/state') {
      // Prefer live relay counts; fall back to stored snapshot when no socket is attached.
      const livePub = this.relay.hasPublisher || session.publisherSessionId !== null;
      return json({
        publisher_active: livePub,
        subscriber_count: Math.max(this.relay.subscriberCount, session.subscriberCount),
        publisher_started_at: session.publisherStartedAt,
        last_activity_at: session.lastActivityAt,
        groups_seen: session.groupsSeen,
        objects_seen: session.objectsSeen,
        live: livePub,
        transport: 'websocket',
      });
    }

    // Legacy JSON register endpoints (kept for the Worker's metadata flow + HTTP clients).
    if (request.method === 'POST') {
      const sessionId = crypto.randomUUID();
      session.publisherSessionId = sessionId;
      session.publisherStartedAt = new Date().toISOString();
      session.lastActivityAt = session.publisherStartedAt;
      await this.save();
      return json({ ok: true, publish_session: sessionId, websocket_url: `wss://${url.host}${url.pathname}` });
    }

    if (request.method === 'GET' && url.pathname.includes('/subscribe/')) {
      const max = parseInt(this.env.MAX_SUBSCRIBERS_PER_TRACK, 10) || 1000;
      if (session.subscriberCount >= max) {
        return json({ type: 'https://httpstatuses.io/429', title: 'Track at subscriber capacity', status: 429, limit: max }, 429);
      }
      session.subscriberCount += 1;
      session.lastActivityAt = new Date().toISOString();
      await this.save();
      return json({ ok: true, subscriber_count: session.subscriberCount, publisher_active: session.publisherSessionId !== null, websocket_url: `wss://${url.host}${url.pathname}` });
    }

    return json({ error: 'method-not-supported' }, 405);
  }

  // ── WebSocket relay ───────────────────────────────────────────────────────────────────────────

  private handleWebSocket(url: URL, org: string | null): Response {
    const max = parseInt(this.env.MAX_SUBSCRIBERS_PER_TRACK, 10) || 1000;
    const isSubscribe = url.pathname.includes('/subscribe/');
    if (isSubscribe && this.relay.subscriberCount >= max) {
      return new Response('subscriber capacity reached', { status: 429 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const sessionId = crypto.randomUUID();
    // Hibernation API: acceptWebSocket() lets CF evict the DO from memory while the socket stays open.
    // We tag the socket with its sessionId (so getWebSockets(sessionId) finds it) and stash a survival
    // attachment; the relay role is filled in once the first control message reveals it (setRole).
    this.state.acceptWebSocket(server, [sessionId]);
    if (org) this.sessionOrgs.set(sessionId, org); // #284: remember the billing org for this connection
    server.serializeAttachment({ sessionId, role: 'pending', org: org ?? undefined } satisfies SocketAttachment);
    this.sockets.set(sessionId, server);
    this.socketIds.set(server, sessionId);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Hibernatable WebSocket handlers (replace addEventListener; survive eviction) ─────────────────

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    this.ensureRehydrated();
    const sessionId = this.sessionIdFor(ws);
    if (sessionId) await this.onMessage(sessionId, message);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.ensureRehydrated();
    const sessionId = this.sessionIdFor(ws);
    if (sessionId) await this.onClose(sessionId);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /** Resolve a socket's session id from the live map, falling back to its survival attachment. */
  private sessionIdFor(ws: WebSocket): string | null {
    const known = this.socketIds.get(ws);
    if (known) return known;
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (att?.sessionId) {
      this.sockets.set(att.sessionId, ws);
      this.socketIds.set(ws, att.sessionId);
      return att.sessionId;
    }
    return null;
  }

  private async onMessage(sessionId: string, data: unknown): Promise<void> {
    const bytes = toBytes(data);
    if (!bytes) return; // ignore non-binary (text) frames — MoQ is binary
    let kind: number;
    let body: Uint8Array;
    try {
      ({ kind, body } = untagFrame(bytes));
    } catch {
      return;
    }
    let events: RelayEvent[] = [];
    if (kind === WS_KIND.CONTROL) {
      const r = this.relay.onControl(sessionId, body);
      for (const out of r.replies) this.send(out.to, WS_KIND.CONTROL, out.frame);
      for (const out of r.objects) this.send(out.to, WS_KIND.OBJECT, out.frame); // late-joiner / FETCH replay
      events = r.events;
    } else if (kind === WS_KIND.OBJECT) {
      const r = this.relay.onObject(sessionId, body);
      for (const out of r.fanout) this.send(out.to, WS_KIND.OBJECT, out.frame);
      events = r.events;
    }
    // Pin the learned role into the socket attachment so a hibernation wake can rebuild the relay.
    for (const e of events) {
      if (e.kind === 'publish_start') this.setRole(e.sessionId, 'publisher');
      else if (e.kind === 'subscribe') this.setRole(e.sessionId, 'subscriber');
    }
    if (events.length) await this.applyEvents(events);
  }

  private async onClose(sessionId: string): Promise<void> {
    const ws = this.sockets.get(sessionId);
    if (ws) {
      this.sockets.delete(sessionId);
      this.socketIds.delete(ws);
    }
    // removeSession emits publish_end for a closing publisher → applyEvents flushes its usage (#284)
    // using session.publisherOrg, so drop this socket's org AFTER applyEvents has run.
    const events = this.relay.removeSession(sessionId);
    if (events.length) await this.applyEvents(events);
    this.sessionOrgs.delete(sessionId);
  }

  private send(sessionId: string, kind: number, frame: Uint8Array): void {
    const ws = this.sockets.get(sessionId);
    if (!ws) return;
    try {
      ws.send(tagFrame(kind, frame));
    } catch {
      void this.onClose(sessionId);
    }
  }

  /** Recording is provisioned only with a billing org + the gateway register wiring + the bucket name. */
  private recordingEnabled(session: SessionState): boolean {
    return Boolean(
      session.publisherOrg && this.env.GATEWAY_BASE_URL && this.env.WAVE_SERVICE_TOKEN && this.env.MOQ_RECORDINGS_BUCKET,
    );
  }

  /** Persist (or clear) the recorder's multipart metadata so a hibernation wake can resume + complete. */
  private async persistRecorderMeta(): Promise<void> {
    const meta = this.recorder?.toMeta() ?? null;
    if (meta) await this.state.storage.put('recorder', meta);
    else await this.state.storage.delete('recorder');
  }

  /**
   * Append one publisher object payload to the session recording. Fail-soft: any R2 error drops the
   * recorder for this session and is swallowed — a recording must NEVER affect the live relay/fan-out.
   * Lazily creates the recorder on the first object (sniffing the container) and resumes a recorder left
   * by a hibernation wake (matched by session id; a stale prior-session upload is aborted, not adopted).
   */
  private async recordPayload(session: SessionState, payload: Uint8Array): Promise<void> {
    if (!this.recordingEnabled(session)) return;
    const org = session.publisherOrg;
    const sid = session.publisherSessionId;
    if (!org || !sid) return;
    try {
      if (!this.recorder && !this.recorderLoaded) {
        this.recorderLoaded = true;
        const meta = await this.state.storage.get<RecorderMeta>('recorder');
        if (meta && meta.sessionId === sid) {
          this.recorder = SessionRecorder.resume(this.env.MOQ_RECORDINGS, meta);
        } else if (meta) {
          await SessionRecorder.resume(this.env.MOQ_RECORDINGS, meta).safeAbort(); // stale → don't adopt
          await this.state.storage.delete('recorder');
        }
      }
      if (!this.recorder) {
        this.recorder = await SessionRecorder.begin(this.env.MOQ_RECORDINGS, org, sid, payload);
        await this.persistRecorderMeta();
      } else {
        const before = this.recorder.partCount;
        await this.recorder.append(payload);
        if (this.recorder.partCount !== before) await this.persistRecorderMeta(); // only on a part flush
      }
    } catch {
      await this.recorder?.safeAbort();
      this.recorder = null;
      try {
        await this.state.storage.delete('recorder');
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Finalize the publisher session recording (if any) and register it with the gateway so the clip/replay
   * chain can resolve it. Fail-soft throughout. Called at publish_end with the org still attributed.
   */
  private async finalizeAndRegister(org: string | null, sessionId: string): Promise<void> {
    // A wake may deliver publish_end before any object event loaded the recorder — restore it first.
    if (!this.recorder && !this.recorderLoaded) {
      this.recorderLoaded = true;
      const meta = await this.state.storage.get<RecorderMeta>('recorder');
      if (meta && meta.sessionId === sessionId) this.recorder = SessionRecorder.resume(this.env.MOQ_RECORDINGS, meta);
    }
    if (!this.recorder) return;
    let done: { key: string; bytes: number } | null = null;
    try {
      done = await this.recorder.finalize();
    } catch {
      await this.recorder.safeAbort();
    }
    this.recorder = null;
    try {
      await this.state.storage.delete('recorder');
    } catch {
      /* ignore */
    }
    if (done && org) {
      this.state.waitUntil(registerRecording(this.env, { org, r2Key: done.key, sessionId }));
    }
  }

  /** Fold relay events into the persisted snapshot + the R4 meter. */
  private async applyEvents(events: RelayEvent[]): Promise<void> {
    const session = await this.load();
    const trackKey = session.trackKey;
    for (const e of events) {
      switch (e.kind) {
        case 'publish_start':
          session.publisherSessionId = e.sessionId;
          session.publisherStartedAt = session.publisherStartedAt ?? new Date().toISOString();
          // #284: attribute the publisher's billing org from the principal captured at WS upgrade.
          // null (anonymous / no gateway principal) → the close-time emit skips (never fabricate an org).
          session.publisherOrg = this.sessionOrgs.get(e.sessionId) ?? null;
          break;
        case 'publish_end': {
          // #284: the publisher session ended → flush its accumulated REAL usage (bytes/frames/reconnects
          // + wall-time as session_ms) to the gateway ingest, fire-and-forget + fail-open. Then reset the
          // track meter + clear publisher fields so the next publisher on this (warm) DO starts at zero —
          // no cross-session over-count. emitMoqUsage no-ops when org is null or the emit is unprovisioned.
          const meter = this.metrics.usage(trackKey);
          const startedMs = session.publisherStartedAt ? Date.parse(session.publisherStartedAt) : 0;
          const sessionMs = startedMs > 0 ? Math.max(0, Date.now() - startedMs) : 0;
          this.state.waitUntil(
            emitMoqUsage(this.env, {
              org: session.publisherOrg,
              trackKey,
              sessionId: e.sessionId,
              bytes: meter.bytes,
              frames: meter.frames,
              reconnects: meter.reconnects,
              sessionMs,
            }),
          );
          // Telemetry (B.4): one customer-exportable OTLP SESSION span with the SAME aggregates —
          // but NO org / track key / sessionId (it ships to a third-party collector → CWE-200).
          // DEFAULT-OFF + fail-soft; independent of the billing emit above.
          this.state.waitUntil(
            emitMoqSessionSpan(this.env, {
              sessionMs,
              bytes: meter.bytes,
              frames: meter.frames,
              reconnects: meter.reconnects,
              status: 'ok',
            }),
          );
          // Finalize the session recording + register it (lights the clip/replay chain). Done before the
          // publisher fields are cleared so the org is still attributed; fail-soft, inert when unprovisioned.
          await this.finalizeAndRegister(session.publisherOrg, e.sessionId);
          this.metrics.reset(trackKey);
          session.publisherSessionId = null;
          session.publisherStartedAt = null;
          session.publisherOrg = null;
          break;
        }
        case 'subscribe':
          session.subscriberCount = this.relay.subscriberCount;
          break;
        case 'unsubscribe':
          session.subscriberCount = this.relay.subscriberCount;
          break;
        case 'object_received':
          session.objectsSeen += 1;
          // Persist the publisher's media to R2 (inert unless recording is provisioned — recordPayload
          // gates internally + fail-soft, so it never blocks fan-out, which already happened upstream).
          if (e.payload && e.payload.length) await this.recordPayload(session, e.payload);
          break;
        case 'group_complete':
          session.groupsSeen += 1;
          break;
      }
      await this.metrics.record({ ts: new Date().toISOString(), kind: e.kind, trackKey, sessionId: e.sessionId, bytes: e.bytes });
    }
    session.lastActivityAt = new Date().toISOString();
    await this.save();
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Coerce a WebSocket message payload to bytes; returns null for text frames. */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  return null;
}
