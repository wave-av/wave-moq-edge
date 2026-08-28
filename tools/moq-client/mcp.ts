#!/usr/bin/env node --experimental-strip-types
/**
 * moq-client MCP surface — stdio JSON-RPC 2.0 server.
 *
 * Exposes four tools backed by the moq-client library modules:
 *   publish_subgroup  — SETUP + PUBLISH_NAMESPACE + SUBGROUP_HEADER frames
 *   subscribe         — SETUP + SUBSCRIBE, report objects/ordering/p50/p95
 *   status            — lightweight connection status probe (REST handshake only)
 *   publish_health    — fire a single publish object as a health check
 *
 * No external dependencies — hand-rolled JSON-RPC 2.0 over stdin/stdout.
 * Env vars: MOQ_JOIN_TOKEN, MOQ_RELAY_URL (same as the CLI).
 *
 * Usage:
 *   node --experimental-transform-types tools/moq-client/mcp.ts          # start MCP server
 *   node --experimental-transform-types tools/moq-client/mcp.ts --help   # usage
 *   node --experimental-transform-types tools/moq-client/mcp.ts --self-test  # smoke test
 */

import { createInterface } from 'node:readline';
import { runPublish, runSubscribe } from './src/session.ts';
import { WebSocketTransport, type Transport } from './src/transport.ts';
import { taiMap, parseRateFlag } from './src/tai-map.ts';
import {
  MOQ_ROLE,
  MOQ_OBJECT_STATUS,
  MOQ_DRAFT_VERSION,
  MOQ_ALPN,
  WS_KIND,
  SUBGROUP_ID_MODE,
  encodeSubgroupStream,
  encodePublishNamespace,
  encodeSetup,
  tagFrame,
  type SubgroupHeader,
  type SubgroupObject,
} from '../../src/moq-wire.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── Env ───────────────────────────────────────────────────────────────────────

function getRelayUrl(): string {
  const url = process.env.MOQ_RELAY_URL;
  if (!url) throw new Error('MOQ_RELAY_URL environment variable is not set');
  return url;
}

function withToken(url: string): string {
  const token = process.env.MOQ_JOIN_TOKEN;
  if (!token) return url;
  const u = new URL(url);
  u.searchParams.set('join', token);
  return u.toString();
}

function redact(url: string): string {
  return url.replace(/([?&]join=)[^&]*/gi, '$1<redacted>');
}

// ── Transport helper ──────────────────────────────────────────────────────────

async function openTransport(url: string, role: 'subscribe' | 'publish'): Promise<Transport> {
  let data: { websocket_url?: string } | null = null;
  try {
    const { execFileSync } = await import('node:child_process');
    const raw = execFileSync(
      'curl',
      ['-sS', '--max-time', '45', '-X', role === 'publish' ? 'POST' : 'GET', withToken(url)],
      { encoding: 'utf8', timeout: 50_000, maxBuffer: 1 << 20 },
    );
    data = JSON.parse(raw) as { websocket_url?: string };
  } catch {
    const res = await fetch(withToken(url), {
      method: role === 'publish' ? 'POST' : 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status >= 400) {
      const body = (await res.text()).slice(0, 120);
      throw new Error(`relay http ${res.status}: ${body}`);
    }
    data = (await res.json()) as { websocket_url?: string };
  }
  if (data?.websocket_url) return WebSocketTransport.connect(withToken(data.websocket_url));
  return WebSocketTransport.connect(withToken(url));
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'publish_subgroup',
    description:
      'SETUP + PUBLISH_NAMESPACE, then emit per-object SUBGROUP_HEADER frames with distinct priorities so relay reorder is observable. Returns a SessionReport with outcome, objects, bytes, ordering, and latency.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Relay publish URL (wss://...). Defaults to MOQ_RELAY_URL.' },
        namespace: { type: 'string', description: 'Track namespace tuple, slash-separated (default: interop/probe).' },
        track: { type: 'string', description: 'Track name (default: probe).' },
        count: { type: 'number', description: 'Number of subgroup objects to emit (default: 3).' },
        interval: { type: 'number', description: 'Milliseconds between subgroup frames (default: 100).' },
        transport: { type: 'string', enum: ['websocket', 'webtransport'], description: 'Transport type (default: websocket).' },
      },
      required: [],
    },
  },
  {
    name: 'subscribe',
    description:
      'SETUP + SUBSCRIBE against a relay; report objects, ordering, and p50/p95 latency. Returns a SessionReport.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Relay subscribe URL (wss://...). Defaults to MOQ_RELAY_URL.' },
        namespace: { type: 'string', description: 'Track namespace tuple, slash-separated (default: interop).' },
        track: { type: 'string', description: 'Track name (default: probe).' },
        duration: { type: 'number', description: 'Subscription duration in ms (default: 10000).' },
        maxObjects: { type: 'number', description: 'Maximum objects to receive before closing.' },
        transport: { type: 'string', enum: ['websocket', 'webtransport'], description: 'Transport type (default: websocket).' },
      },
      required: [],
    },
  },
  {
    name: 'status',
    description:
      'Lightweight status probe: performs the REST handshake against the relay and returns the session URL and connection state without opening a WebSocket. Useful for checking relay reachability and auth.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Relay URL to probe. Defaults to MOQ_RELAY_URL.' },
        role: { type: 'string', enum: ['publish', 'subscribe'], description: 'Handshake role (default: subscribe).' },
      },
      required: [],
    },
  },
  {
    name: 'publish_health',
    description:
      'Fire a single publish object as a health check. Returns ok/connection-refused with timing. Intended for quick liveness probes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Relay publish URL. Defaults to MOQ_RELAY_URL.' },
        namespace: { type: 'string', description: 'Track namespace (default: health).' },
        track: { type: 'string', description: 'Track name (default: check).' },
      },
      required: [],
    },
  },
  {
    name: 'tai_map',
    description:
      'E1-TAI-BRIDGE: map an absolute TAI instant + exact frame rate to the deterministic MoQ group id (pure function, no network, no relay required). Same inputs always produce the same groupId in any process. Also returns the exact frame period, the round-trip group-start instant, an optional media-clock value, and the ST 2110 timing property-bag byte length.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taiNs: { type: 'string', description: 'Absolute source time, TAI nanoseconds (string to preserve bigint precision).' },
        rate: { type: 'string', description: 'Exact frame rate as NUM/DEN, e.g. "30000/1001" (default: "30/1").' },
        frameIndex: { type: 'string', description: 'If set, also compute the media-clock value for this frame index.' },
        mediaClockRateHz: { type: 'string', description: 'Media clock rate in Hz, used with frameIndex (default: 90000).' },
      },
      required: ['taiNs'],
    },
  },
] as const;

// ── Tool implementations ──────────────────────────────────────────────────────

const SUBGROUP_PRIORITIES = [200, 100, 150];

async function handlePublishSubgroup(args: Record<string, unknown>): Promise<unknown> {
  const url = (args.url as string) || getRelayUrl();
  const namespace = ((args.namespace as string) ?? 'interop/probe').split('/').filter(Boolean);
  const track = (args.track as string) ?? 'probe';
  const count = Number(args.count ?? 3);
  const intervalMs = Number(args.interval ?? 100);

  let transport: Transport;
  try {
    transport = await openTransport(url, 'publish');
  } catch (e) {
    return {
      peer: redact(url),
      outcome: 'connection-refused',
      evidence: e instanceof Error ? e.message : String(e),
      observedAt: new Date().toISOString(),
    };
  }

  try {
    const tracked = (kind: number, body: Uint8Array) => {
      transport.send(transport.kind === 'websocket' ? tagFrame(kind, body) : body);
    };
    tracked(WS_KIND.CONTROL, encodeSetup({ role: MOQ_ROLE.PUBLISHER, maxSubscriptions: 0n }));
    tracked(WS_KIND.CONTROL, encodePublishNamespace({ requestId: 1n, trackNamespace: namespace }));

    let sent = 0;
    let bytes = 0;

    for (let i = 0; i < count; i++) {
      const closed = await Promise.race([
        transport.closeInfo.then((c) => c),
        new Promise<null>((r) => setTimeout(() => r(null), 0)),
      ]);
      if (closed) {
        return {
          peer: redact(url),
          transport: transport.kind,
          transportAlpn: transport.alpn,
          moqDraft: MOQ_DRAFT_VERSION,
          moqAlpn: MOQ_ALPN,
          role: 'publisher',
          observedAt: new Date().toISOString(),
          outcome: closed.code === 1008 || closed.code === 3401 ? 'auth-rejected' : 'transport-error',
          evidence: `peer closed mid-publish: code=${closed.code}${closed.reason ? ` reason="${closed.reason}"` : ''}`,
          objects: sent,
          bytes,
          ordering: { outOfOrder: 0, missing: 0, monotonic: true },
          latency: { count: 0, p50Ms: null, p95Ms: null, minMs: null, maxMs: null },
          closeCode: closed.code,
          closeReason: closed.reason,
        };
      }

      const priority = SUBGROUP_PRIORITIES[i % SUBGROUP_PRIORITIES.length];
      const objectId = BigInt(i);
      const payload = new TextEncoder().encode(`obj:${i}:priority:${priority}`);

      const header: SubgroupHeader = {
        trackAlias: 1n,
        groupId: 0n,
        subgroupId: 0n,
        idMode: SUBGROUP_ID_MODE.EXPLICIT,
        priority,
        defaultPriority: false,
        endOfGroup: i === count - 1,
        firstObject: i === 0,
      };
      const objects: SubgroupObject[] = [{ objectId, status: MOQ_OBJECT_STATUS.NORMAL, payload }];
      tracked(WS_KIND.OBJECT, encodeSubgroupStream(header, objects));
      sent++;
      bytes += payload.length;

      if (intervalMs > 0 && i < count - 1) await new Promise((r) => setTimeout(r, intervalMs));
    }

    return {
      peer: redact(url),
      transport: transport.kind,
      transportAlpn: transport.alpn,
      moqDraft: MOQ_DRAFT_VERSION,
      moqAlpn: MOQ_ALPN,
      role: 'publisher',
      observedAt: new Date().toISOString(),
      outcome: 'ok',
      evidence: `published ${sent} subgroup object(s) to ${namespace.join('/')}/${track}`,
      objects: sent,
      bytes,
      ordering: { outOfOrder: 0, missing: 0, monotonic: true },
      latency: { count: 0, p50Ms: null, p95Ms: null, minMs: null, maxMs: null },
    };
  } finally {
    transport.close();
  }
}

async function handleSubscribe(args: Record<string, unknown>): Promise<unknown> {
  const url = (args.url as string) || getRelayUrl();
  const namespace = ((args.namespace as string) ?? 'interop').split('/').filter(Boolean);
  const track = (args.track as string) ?? 'probe';
  const durationMs = Number(args.duration ?? 10_000);
  const maxObjects = args.maxObjects != null ? Number(args.maxObjects) : undefined;

  let transport: Transport;
  try {
    transport = await openTransport(url, 'subscribe');
  } catch (e) {
    return {
      peer: redact(url),
      outcome: 'connection-refused',
      evidence: e instanceof Error ? e.message : String(e),
      observedAt: new Date().toISOString(),
    };
  }

  try {
    return await runSubscribe({
      transport,
      peer: redact(url),
      namespace,
      track,
      durationMs,
      maxObjects,
    });
  } finally {
    transport.close();
  }
}

async function handleStatus(args: Record<string, unknown>): Promise<unknown> {
  const url = (args.url as string) || getRelayUrl();
  const role = (args.role as string) ?? 'subscribe';

  try {
    const { execFileSync } = await import('node:child_process');
    const raw = execFileSync(
      'curl',
      ['-sS', '--max-time', '10', '-X', role === 'publish' ? 'POST' : 'GET', withToken(url)],
      { encoding: 'utf8', timeout: 15_000, maxBuffer: 1 << 20 },
    );
    const data = JSON.parse(raw);
    return {
      status: 'ok',
      relayUrl: redact(url),
      role,
      websocketUrl: data.websocket_url ? redact(data.websocket_url) : null,
      observedAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      status: 'error',
      relayUrl: redact(url),
      role,
      evidence: e instanceof Error ? e.message : String(e),
      observedAt: new Date().toISOString(),
    };
  }
}

async function handlePublishHealth(args: Record<string, unknown>): Promise<unknown> {
  const url = (args.url as string) || getRelayUrl();
  const namespace = ((args.namespace as string) ?? 'health').split('/').filter(Boolean);
  const track = (args.track as string) ?? 'check';

  let transport: Transport;
  try {
    transport = await openTransport(url, 'publish');
  } catch (e) {
    return {
      status: 'unreachable',
      evidence: e instanceof Error ? e.message : String(e),
      observedAt: new Date().toISOString(),
    };
  }

  try {
    const report = await runPublish({
      transport,
      peer: redact(url),
      namespace,
      track,
      count: 1,
      intervalMs: 0,
      payloadBytes: 32,
    });
    return {
      status: report.outcome === 'ok' ? 'healthy' : 'degraded',
      outcome: report.outcome,
      evidence: report.evidence,
      observedAt: report.observedAt,
    };
  } finally {
    transport.close();
  }
}

async function handleTaiMap(args: Record<string, unknown>): Promise<unknown> {
  const taiNsRaw = args.taiNs as string | undefined;
  if (!taiNsRaw) throw new Error('taiNs is required');
  return taiMap({
    taiNs: BigInt(taiNsRaw),
    rate: parseRateFlag(args.rate as string | undefined),
    frameIndex: args.frameIndex !== undefined ? BigInt(args.frameIndex as string) : undefined,
    mediaClockRateHz: args.mediaClockRateHz !== undefined ? BigInt(args.mediaClockRateHz as string) : undefined,
  });
}

// ── JSON-RPC dispatch ─────────────────────────────────────────────────────────

const HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  publish_subgroup: handlePublishSubgroup,
  subscribe: handleSubscribe,
  status: handleStatus,
  publish_health: handlePublishHealth,
  tai_map: handleTaiMap,
};

function respond(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function respondError(id: number | string | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  if (req.method === 'initialize') {
    return respond(req.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'moq-client', version: '0.1.0' },
    });
  }
  if (req.method === 'notifications/initialized') {
    return respond(req.id, undefined);
  }
  if (req.method === 'tools/list') {
    return respond(req.id, { tools: TOOLS });
  }
  if (req.method === 'tools/call') {
    const params = req.params as { name: string; arguments?: Record<string, unknown> } | undefined;
    if (!params?.name) return respondError(req.id, -32602, 'Missing tool name');
    const handler = HANDLERS[params.name];
    if (!handler) return respondError(req.id, -32601, `Unknown tool: ${params.name}`);
    try {
      const result = await handler(params.arguments ?? {});
      return respond(req.id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      });
    } catch (e) {
      return respondError(req.id, -32000, e instanceof Error ? e.message : String(e), { cause: e instanceof Error ? e.stack : undefined });
    }
  }
  return respondError(req.id, -32601, `Method not found: ${req.method}`);
}

// ── stdin/stdout reader ───────────────────────────────────────────────────────

// `rl.on('line', async ...)` fires-and-forgets a promise per line; `readline`'s 'close' event
// (stdin EOF) does NOT wait for those promises to settle, so exiting on 'close' can race an
// in-flight `tools/call` and drop its response before it reaches stdout — a real bug found while
// building this phase's end-to-end MCP receipt (a single-request pipe reproduced it 100% of the
// time). Fixed by tracking in-flight request count and deferring `process.exit` until it drains.
let inFlight = 0;
let closed = false;
function maybeExit(): void {
  if (closed && inFlight === 0) process.exit(0);
}

function runServer(): void {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    inFlight++;
    try {
      const req = JSON.parse(trimmed) as JsonRpcRequest;
      const res = await handleRequest(req);
      process.stdout.write(JSON.stringify(res) + '\n');
    } catch {
      process.stdout.write(
        JSON.stringify(respondError(null, -32700, 'Parse error')) + '\n',
      );
    } finally {
      inFlight--;
      maybeExit();
    }
  });
  rl.on('close', () => {
    closed = true;
    maybeExit();
  });
}

// ── Self-test ─────────────────────────────────────────────────────────────────

async function selfTest(): Promise<number> {
  const results: string[] = [];

  // Test 1: initialize
  const initReq: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
  const initRes = await handleRequest(initReq);
  const initOk = initRes.result && typeof initRes.result === 'object' &&
    (initRes.result as Record<string, unknown>).protocolVersion === '2024-11-05';
  results.push(`initialize: ${initOk ? 'PASS' : 'FAIL'}`);

  // Test 2: tools/list
  const listReq: JsonRpcRequest = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
  const listRes = await handleRequest(listReq);
  const listResult = listRes.result as { tools: Array<{ name: string }> } | undefined;
  const toolNames = listResult?.tools?.map((t) => t.name) ?? [];
  const expected = ['publish_subgroup', 'subscribe', 'status', 'publish_health', 'tai_map'];
  const listOk = expected.every((n) => toolNames.includes(n));
  results.push(`tools/list: ${listOk ? 'PASS' : 'FAIL'} (found: ${toolNames.join(', ')})`);

  // Test 3: tools/call unknown
  const unknownReq: JsonRpcRequest = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nonexistent' } };
  const unknownRes = await handleRequest(unknownReq);
  const unknownOk = unknownRes.error?.code === -32601;
  results.push(`tools/call unknown: ${unknownOk ? 'PASS' : 'FAIL'}`);

  // Test 4: parse error
  const parseRes = await handleRequest(JSON.parse('{"jsonrpc":"2.0","id":null,"method":"nope"}'));
  const parseOk = parseRes.error?.code === -32601;
  results.push(`method not found: ${parseOk ? 'PASS' : 'FAIL'}`);

  const allPassed = results.every((r) => r.includes('PASS'));
  for (const r of results) process.stdout.write(`  ${r}\n`);
  process.stdout.write(allPassed ? '\nAll self-tests passed.\n' : '\nSome self-tests FAILED.\n');
  return allPassed ? 0 : 1;
}

// ── CLI entry ─────────────────────────────────────────────────────────────────

const USAGE = `moq-client MCP — stdio JSON-RPC 2.0 server for agent consumption.

Usage:
  node --experimental-transform-types tools/moq-client/mcp.ts            Start MCP server on stdin/stdout
  node --experimental-transform-types tools/moq-client/mcp.ts --help     Show this help
  node --experimental-transform-types tools/moq-client/mcp.ts --self-test  Run in-process smoke tests

Environment:
  MOQ_RELAY_URL    Default relay URL (tools accept an override 'url' param)
  MOQ_JOIN_TOKEN   Join token appended as ?join= to relay URLs

Tools:
  publish_subgroup   SETUP + PUBLISH_NAMESPACE + SUBGROUP_HEADER frames
  subscribe          SETUP + SUBSCRIBE, report objects/ordering/p50/p95
  status             REST handshake probe (no WebSocket opened)
  publish_health     Single-object health check
  tai_map            E1-TAI-BRIDGE: TAI instant + rate -> deterministic MoQ group id (no network)`;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args.includes('--self-test')) {
    return selfTest();
  }
  // Server mode: `main()` must NOT resolve here — the outer `.then` below calls `process.exit`
  // the instant this promise settles, which (found while building this phase's end-to-end MCP
  // receipt) killed the process before `runServer`'s readline ever got a turn on the event loop,
  // so every stdio request was silently dropped regardless of the close-race fix above. Returning
  // a promise that never resolves keeps main() pending while the (unref'd-nothing, still real)
  // stdin listener keeps the event loop alive; `runServer`'s own `maybeExit()` is the only exit path.
  runServer();
  return new Promise<number>(() => {});
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`moq-client MCP: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
