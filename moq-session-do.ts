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
 * We use the non-hibernation `server.accept()` API deliberately: it pins the DO in memory while a
 * socket is open, so the in-memory MoqRelay (subscriber set, publisher, track alias) stays valid for
 * the life of the session — the simplest correct model for a live relay. (Hibernation-survival is a
 * follow-up; it would rebuild relay state from getWebSockets() attachments on wake.)
 *
 * The legacy JSON endpoints (/state, POST register, GET subscribe-register) are preserved so the
 * Worker's metadata routes and any HTTP client keep working alongside the new WS relay path.
 */
import { MoqRelay, type RelayEvent } from './src/moq-relay';
import { WS_KIND, tagFrame, untagFrame } from './src/moq-wire';
import { MetricsCollector } from './metrics-collector';

interface Env {
  MOQ_TRACK_REGISTRY: KVNamespace;
  MOQ_RECORDINGS: R2Bucket;
  ENVIRONMENT: string;
  MOQ_DRAFT_VERSION: string;
  MAX_SUBSCRIBERS_PER_TRACK: string;
  MAX_OBJECT_SIZE_BYTES: string;
  LOG_LEVEL: string;
}

interface SessionState {
  trackKey: string;
  publisherSessionId: string | null;
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

  // Live relay + transport state (valid while at least one socket is open; see file header).
  private relay = new MoqRelay();
  private sockets = new Map<string, WebSocket>(); // sessionId → socket
  private socketIds = new WeakMap<WebSocket, string>();
  private metrics: MetricsCollector;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.metrics = new MetricsCollector(env);
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

    // WebSocket relay upgrade (publisher or subscriber). The path tells us the intended role, but
    // the authoritative role comes from the first control message (PUBLISH_NAMESPACE vs SUBSCRIBE).
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return this.handleWebSocket(url);
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

  private handleWebSocket(url: URL): Response {
    const max = parseInt(this.env.MAX_SUBSCRIBERS_PER_TRACK, 10) || 1000;
    const isSubscribe = url.pathname.includes('/subscribe/');
    if (isSubscribe && this.relay.subscriberCount >= max) {
      return new Response('subscriber capacity reached', { status: 429 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept(); // non-hibernation: pins the DO while the socket is open (keeps relay state live)

    const sessionId = crypto.randomUUID();
    this.sockets.set(sessionId, server);
    this.socketIds.set(server, sessionId);

    server.addEventListener('message', (ev: MessageEvent) => {
      void this.onMessage(sessionId, ev.data);
    });
    const drop = () => void this.onClose(sessionId);
    server.addEventListener('close', drop);
    server.addEventListener('error', drop);

    return new Response(null, { status: 101, webSocket: client });
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
      events = r.events;
    } else if (kind === WS_KIND.OBJECT) {
      const r = this.relay.onObject(sessionId, body);
      for (const out of r.fanout) this.send(out.to, WS_KIND.OBJECT, out.frame);
      events = r.events;
    }
    if (events.length) await this.applyEvents(events);
  }

  private async onClose(sessionId: string): Promise<void> {
    const ws = this.sockets.get(sessionId);
    if (ws) {
      this.sockets.delete(sessionId);
      this.socketIds.delete(ws);
    }
    const events = this.relay.removeSession(sessionId);
    if (events.length) await this.applyEvents(events);
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

  /** Fold relay events into the persisted snapshot + the R4 meter. */
  private async applyEvents(events: RelayEvent[]): Promise<void> {
    const session = await this.load();
    const trackKey = session.trackKey;
    for (const e of events) {
      switch (e.kind) {
        case 'publish_start':
          session.publisherSessionId = e.sessionId;
          session.publisherStartedAt = session.publisherStartedAt ?? new Date().toISOString();
          break;
        case 'publish_end':
          session.publisherSessionId = null;
          break;
        case 'subscribe':
          session.subscriberCount = this.relay.subscriberCount;
          break;
        case 'unsubscribe':
          session.subscriberCount = this.relay.subscriberCount;
          break;
        case 'object_received':
          session.objectsSeen += 1;
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
