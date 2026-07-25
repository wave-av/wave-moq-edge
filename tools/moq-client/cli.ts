#!/usr/bin/env node --experimental-strip-types
/**
 * moq-client — a non-Worker MoQ interop client.
 *
 * Three subcommands:
 *   probe-alpn  offer a configurable ALPN list over raw QUIC and report accept/refuse per ALPN
 *   subscribe   SETUP + SUBSCRIBE against a relay; report objects, ordering and p50/p95
 *   publish     SETUP + PUBLISH_NAMESPACE; emit timestamped objects
 *
 * Credentials: a join token is read from the MOQ_JOIN_TOKEN environment variable only. It is placed
 * in the request URL because the relay reads `?join=<token>` (browser WebSocket clients cannot set
 * headers), and every URL this tool prints is redacted first — see `redact`.
 */

import { probeAlpnMatrix, type AlpnProbeResult } from './src/quic-alpn.ts';
import { CONTROL_ALPNS, MOQ_ALPN_CANDIDATES, RELAY_TARGETS, resolveTarget } from './src/targets.ts';
import { runPublish, runSubscribe, type SessionReport } from './src/session.ts';
import { WebSocketTransport, WebTransportTransport, type Transport } from './src/transport.ts';

interface Args {
  cmd: string;
  flags: Map<string, string>;
  positional: string[];
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) flags.set(a.slice(2), 'true');
      else flags.set(a.slice(2, eq), a.slice(eq + 1));
    } else positional.push(a);
  }
  return { cmd: positional.shift() ?? 'help', flags, positional };
}

/** Strip any join token from a URL before it is printed or logged. Never widen this. */
export function redact(url: string): string {
  return url.replace(/([?&]join=)[^&]*/gi, '$1<redacted>');
}

const USAGE = `moq-client — non-Worker MoQ interop client

  probe-alpn [target...]   Offer each ALPN in isolation over raw QUIC; report accept/refuse.
    --alpn=a,b,c           ALPN list to test   (default: ${MOQ_ALPN_CANDIDATES.join(',')})
    --control=h3           Control ALPN(s) proving the peer is a live QUIC server (default: h3)
    --timeout=5000         Per-probe budget in ms
    --json                 Emit the raw result array
    (no target -> every entry in the built-in target list)

  subscribe <url>          SETUP + SUBSCRIBE, then report objects/ordering/p50/p95.
    --ns=a/b --track=t     Track namespace tuple and track name
    --transport=websocket|webtransport
    --duration=10000 --max-objects=100 --json

  publish <url>            SETUP + PUBLISH_NAMESPACE, then emit timestamped objects.
    --ns=a/b --track=t --count=20 --interval=100 --bytes=64 --json

Auth: set MOQ_JOIN_TOKEN in the environment. It is never printed.`;

function alpnTable(results: AlpnProbeResult[]): string {
  const w = Math.max(...results.map((r) => (r.isolated ?? r.offered.join('+')).length), 8);
  const lines = results.map((r) => {
    const name = (r.isolated ?? `[joint] ${r.offered.join(',')}`).padEnd(w);
    const rtt = r.rttMs === null ? '   —   ' : `${r.rttMs.toFixed(1).padStart(6)}ms`;
    return `  ${name}  ${r.outcome.padEnd(19)} ${rtt}  ${r.evidence}`;
  });
  return lines.join('\n');
}

async function cmdProbeAlpn(args: Args): Promise<number> {
  const alpns = (args.flags.get('alpn') ?? MOQ_ALPN_CANDIDATES.join(',')).split(',').filter(Boolean);
  const control = (args.flags.get('control') ?? CONTROL_ALPNS.join(',')).split(',').filter(Boolean);
  const timeoutMs = Number(args.flags.get('timeout') ?? 5000);
  const targets = args.positional.length > 0 ? args.positional.map(resolveTarget) : RELAY_TARGETS;

  const all: Record<string, AlpnProbeResult[]> = {};
  for (const t of targets) {
    if (!args.flags.has('json')) {
      process.stdout.write(`\n${t.id}  (${t.host}:${t.port})${t.control ? '  [CONTROL]' : ''}\n  ${t.note}\n`);
    }
    const results = await probeAlpnMatrix(alpns, { host: t.host, port: t.port, timeoutMs, control });
    all[t.id] = results;
    if (!args.flags.has('json')) process.stdout.write(`${alpnTable(results)}\n`);
  }

  if (args.flags.has('json')) {
    process.stdout.write(`${JSON.stringify(all, null, 2)}\n`);
    return 0;
  }

  // A refusal only means something when the control ALPN was accepted on the same host and code path.
  process.stdout.write('\nSummary\n');
  for (const [id, results] of Object.entries(all)) {
    const controlOk = results.some((r) => control.includes(r.isolated ?? '') && r.outcome === 'accepted');
    const accepted = results.filter((r) => r.isolated && !control.includes(r.isolated) && r.outcome === 'accepted');
    const refused = results.filter((r) => r.isolated && !control.includes(r.isolated) && r.outcome === 'refused');
    if (!controlOk) {
      process.stdout.write(`  ${id}: INCONCLUSIVE — the control ALPN did not complete, so no refusal is attributable to this peer.\n`);
      continue;
    }
    process.stdout.write(
      `  ${id}: MoQ ALPN accepted = ${accepted.length ? accepted.map((r) => r.isolated).join(', ') : 'none'}` +
        ` | refused = ${refused.length ? refused.map((r) => r.isolated).join(', ') : 'none'}\n`,
    );
  }
  return 0;
}

function withToken(url: string): string {
  const token = process.env.MOQ_JOIN_TOKEN;
  if (!token) return url;
  const u = new URL(url);
  u.searchParams.set('join', token);
  return u.toString();
}

async function openTransport(url: string, kind: string): Promise<Transport> {
  if (kind === 'webtransport') return WebTransportTransport.connect(withToken(url));
  return WebSocketTransport.connect(withToken(url));
}

function printReport(r: SessionReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return;
  }
  const l = r.latency;
  process.stdout.write(
    `\n${r.role} @ ${r.peer}\n` +
      `  transport      ${r.transport}${r.transportAlpn ? ` (ALPN ${r.transportAlpn})` : ' (no ALPN exposed)'}\n` +
      `  moq draft      ${r.moqDraft} (${r.moqAlpn})\n` +
      `  outcome        ${r.outcome}\n` +
      `  evidence       ${r.evidence}\n` +
      `  objects        ${r.objects} (${r.bytes} payload bytes)\n` +
      `  ordering       monotonic=${r.ordering.monotonic} outOfOrder=${r.ordering.outOfOrder} missing=${r.ordering.missing}\n` +
      `  latency        p50=${l.p50Ms ?? '—'}ms p95=${l.p95Ms ?? '—'}ms min=${l.minMs ?? '—'}ms max=${l.maxMs ?? '—'}ms n=${l.count}\n`,
  );
}

async function cmdSession(args: Args, role: 'subscribe' | 'publish'): Promise<number> {
  const url = args.positional[0];
  if (!url) {
    process.stderr.write('error: a relay URL is required\n');
    return 2;
  }
  const namespace = (args.flags.get('ns') ?? 'interop').split('/').filter(Boolean);
  const track = args.flags.get('track') ?? 'probe';
  const json = args.flags.has('json');

  let transport: Transport;
  try {
    transport = await openTransport(url, args.flags.get('transport') ?? 'websocket');
  } catch (e) {
    // A failed dial IS a receipt — emit it in the same shape as a success.
    const report = {
      peer: redact(url),
      outcome: 'connection-refused',
      evidence: e instanceof Error ? e.message : String(e),
      observedAt: new Date().toISOString(),
    };
    process.stdout.write(`${json ? JSON.stringify(report, null, 2) : `\nconnection-refused @ ${report.peer}\n  ${report.evidence}\n`}\n`);
    return 1;
  }

  try {
    const report =
      role === 'subscribe'
        ? await runSubscribe({
            transport,
            peer: redact(url),
            namespace,
            track,
            durationMs: Number(args.flags.get('duration') ?? 10000),
            maxObjects: args.flags.has('max-objects') ? Number(args.flags.get('max-objects')) : undefined,
          })
        : await runPublish({
            transport,
            peer: redact(url),
            namespace,
            track,
            count: Number(args.flags.get('count') ?? 20),
            intervalMs: Number(args.flags.get('interval') ?? 100),
            payloadBytes: Number(args.flags.get('bytes') ?? 64),
          });
    printReport(report, json);
    return report.outcome === 'ok' ? 0 : 1;
  } finally {
    transport.close();
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.cmd) {
    case 'probe-alpn':
      return cmdProbeAlpn(args);
    case 'subscribe':
      return cmdSession(args, 'subscribe');
    case 'publish':
      return cmdSession(args, 'publish');
    default:
      process.stdout.write(`${USAGE}\n`);
      return args.cmd === 'help' ? 0 : 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`moq-client: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
