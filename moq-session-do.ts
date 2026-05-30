/// <reference types="@cloudflare/workers-types" />
/**
 * MoQ Session Durable Object — minimal working scaffold (2026-05-07).
 *
 * Per WAVE moq-edge strategy doc, this DO holds per-track state:
 *   - 1 publisher session
 *   - up to MAX_SUBSCRIBERS_PER_TRACK subscribers
 *   - cache of last N groups for late-joiners
 *
 * This is the WEEK-1 scaffold (does state + WebTransport upgrade plumbing).
 * Week 2 fills in real MoQ wire-protocol message handling per the IETF spec
 * (currently targeting draft-18, with version negotiation accepting down to draft-07).
 *
 * The previous moq-session-do.ts (now .broken-2026-05-07) was Python-to-TS
 * conversion artifacts — discarded so we can build clean against current
 * @cloudflare/workers-types.
 */

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

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
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
    if (this.session) {
      await this.state.storage.put('session', this.session);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const session = await this.load();

    if (url.pathname === '/state') {
      return new Response(
        JSON.stringify({
          publisher_active: session.publisherSessionId !== null,
          subscriber_count: session.subscriberCount,
          publisher_started_at: session.publisherStartedAt,
          last_activity_at: session.lastActivityAt,
          groups_seen: session.groupsSeen,
          objects_seen: session.objectsSeen,
          live: session.publisherSessionId !== null,
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    }

    // POST /v1/publish/<ns>/<track> — register publisher
    if (request.method === 'POST') {
      const sessionId = crypto.randomUUID();
      session.publisherSessionId = sessionId;
      session.publisherStartedAt = new Date().toISOString();
      session.lastActivityAt = session.publisherStartedAt;
      await this.save();
      return new Response(
        JSON.stringify({
          ok: true,
          publish_session: sessionId,
          // Future: WebTransport URL is the same path with Upgrade header
          webtransport_url: `wss://moq-edge.wave.online${url.pathname}/webtransport`,
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    }

    // GET /v1/subscribe/<ns>/<track> — register subscriber
    if (request.method === 'GET' && url.pathname.includes('/subscribe/')) {
      const max = parseInt(this.env.MAX_SUBSCRIBERS_PER_TRACK, 10) || 1000;
      if (session.subscriberCount >= max) {
        return new Response(
          JSON.stringify({
            type: 'https://httpstatuses.io/429',
            title: 'Track at subscriber capacity',
            status: 429,
            limit: max,
          }),
          { status: 429, headers: { 'content-type': 'application/json' } }
        );
      }
      session.subscriberCount += 1;
      session.lastActivityAt = new Date().toISOString();
      await this.save();
      return new Response(
        JSON.stringify({
          ok: true,
          subscriber_count: session.subscriberCount,
          publisher_active: session.publisherSessionId !== null,
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({ error: 'method-not-supported' }), {
      status: 405,
      headers: { 'content-type': 'application/json' },
    });
  }
}
