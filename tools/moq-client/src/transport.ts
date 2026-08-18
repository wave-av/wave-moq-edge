/**
 * Message transports for the MoQ session client.
 *
 * The MoQ session logic (session.ts) never knows which of these it is talking through — the same
 * SETUP / SUBSCRIBE / object flow drives WAVE's own relay and a foreign one. That is what makes this
 * an interop instrument rather than a self-test: if a bug lived in the session layer it would show
 * up on both peers, and if it lives in one peer only the transport is the only thing that differed.
 *
 * Two bindings ship:
 *   - `WebSocketTransport` — RFC 6455, the binding WAVE's own relay serves today (Workers has no
 *     WebTransport *server* API). Uses Node's global WebSocket, so it carries no dependency.
 *   - `WebTransportTransport` — native QUIC/HTTP-3, the binding foreign relays expect. It is loaded
 *     LAZILY from an optional peer dependency so that neither the build, the type-check, nor the
 *     unit tests require a native addon to be installed.
 *
 * A transport reports its ALPN as OBSERVED, not as assumed: WebSocket has no ALPN of its own beyond
 * the underlying TLS (`http/1.1` for the upgrade), and WebTransport is always `h3` — over which the
 * MoQ draft version is negotiated in SETUP, not in ALPN. Measuring MoQ ALPN itself therefore belongs
 * to the raw-QUIC prober in quic-alpn.ts, not here, and the two must not be conflated.
 */

export interface Transport {
  readonly kind: 'websocket' | 'webtransport';
  /** The ALPN this transport actually negotiates, or null when it does not expose one. */
  readonly alpn: string | null;
  send(bytes: Uint8Array): void;
  /** Resolves with the next inbound message, or null once the peer closes. */
  receive(): Promise<Uint8Array | null>;
  close(): void;
  readonly closeInfo: Promise<{ code: number; reason: string }>;
}

/** A bounded inbound queue shared by both transports. */
class MessageQueue {
  private readonly queue: Uint8Array[] = [];
  private waiter: ((v: Uint8Array | null) => void) | null = null;
  private ended = false;

  push(bytes: Uint8Array): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(bytes);
      return;
    }
    this.queue.push(bytes);
  }

  end(): void {
    this.ended = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(null);
    }
  }

  next(): Promise<Uint8Array | null> {
    const head = this.queue.shift();
    if (head) return Promise.resolve(head);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

export class WebSocketTransport implements Transport {
  readonly kind = 'websocket' as const;
  /** The upgrade rides ordinary TLS; there is no MoQ ALPN to report and we must not invent one. */
  readonly alpn = null;
  readonly closeInfo: Promise<{ code: number; reason: string }>;
  private readonly ws: WebSocket;
  private readonly queue = new MessageQueue();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('message', (ev: MessageEvent) => {
      const d = ev.data;
      if (d instanceof ArrayBuffer) this.queue.push(new Uint8Array(d));
      else if (typeof d === 'string') this.queue.push(new TextEncoder().encode(d));
    });
    this.closeInfo = new Promise((resolve) => {
      ws.addEventListener('close', (ev: CloseEvent) => {
        this.queue.end();
        resolve({ code: ev.code, reason: ev.reason });
      });
      ws.addEventListener('error', () => {
        this.queue.end();
        resolve({ code: -1, reason: 'websocket error' });
      });
    });
  }

  /** `url` carries `?join=<token>` when the relay enforces join-tokens — never a header, never a log. */
  static connect(url: string, timeoutMs = 30000): Promise<WebSocketTransport> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`websocket open timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new WebSocketTransport(ws));
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        // The DOM error event carries no detail by design; the close code below is the real signal.
        reject(new Error('websocket connection failed before open'));
      });
    });
  }

  send(bytes: Uint8Array): void {
    this.ws.send(bytes);
  }

  receive(): Promise<Uint8Array | null> {
    return this.queue.next();
  }

  close(): void {
    try {
      this.ws.close(1000, 'client done');
    } catch {
      /* already closing */
    }
  }
}

/**
 * Native QUIC/WebTransport binding, loaded lazily from the optional `@fails-components/webtransport`
 * peer dependency. If it is not installed, this throws an error that names the exact install command
 * rather than failing somewhere deeper with an unrelated message.
 */
/**
 * The shape we need from a WebTransport session. Declared locally because the binding is an OPTIONAL
 * native peer dependency: importing its types unconditionally would make `npm run typecheck:client`
 * fail on a machine that has not installed a native addon, which would be a bad trade for a tool
 * whose whole job is to keep working in hostile environments.
 */
interface WtSession {
  datagrams: { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> };
  close: (info?: { closeCode: number; reason: string }) => void;
  closed: Promise<{ closeCode: number; reason: string }>;
  ready: Promise<void>;
}

export class WebTransportTransport implements Transport {
  readonly kind = 'webtransport' as const;
  /** WebTransport is HTTP/3: ALPN is always `h3`, and the MoQ version is settled in SETUP instead. */
  readonly alpn = 'h3';
  readonly closeInfo: Promise<{ code: number; reason: string }>;
  private readonly queue = new MessageQueue();

  private constructor(
    private readonly session: WtSession,
    private readonly writer: WritableStreamDefaultWriter<Uint8Array>,
  ) {
    this.closeInfo = session.closed.then(
      (i) => {
        this.queue.end();
        return { code: i.closeCode, reason: i.reason };
      },
      (e: unknown) => {
        this.queue.end();
        return { code: -1, reason: e instanceof Error ? e.message : String(e) };
      },
    );
    void this.pump(session.datagrams.readable);
  }

  private async pump(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) this.queue.push(value);
      }
    } catch {
      /* session teardown */
    } finally {
      this.queue.end();
    }
  }

  static async connect(url: string): Promise<WebTransportTransport> {
    let mod: { WebTransport: new (url: string) => WtSession };
    try {
      // Specifier built at runtime so the type-checker does not require the optional addon to exist.
      const specifier = '@fails-components/webtransport';
      mod = (await import(/* @vite-ignore */ specifier)) as unknown as typeof mod;
    } catch {
      throw new Error(
        'WebTransport binding unavailable: install the optional native peer dependency with ' +
          '`npm i -D @fails-components/webtransport`, or use --transport=websocket. ' +
          'Note that WebTransport negotiates ALPN `h3` and therefore cannot measure MoQ ALPN — ' +
          'use `probe-alpn` for that.',
      );
    }
    const session = new mod.WebTransport(url);
    await session.ready;
    const writer = session.datagrams.writable.getWriter();
    return new WebTransportTransport(session, writer);
  }

  send(bytes: Uint8Array): void {
    void this.writer.write(bytes);
  }

  receive(): Promise<Uint8Array | null> {
    return this.queue.next();
  }

  close(): void {
    try {
      this.session.close({ closeCode: 0, reason: 'client done' });
    } catch {
      /* already closed */
    }
  }
}
