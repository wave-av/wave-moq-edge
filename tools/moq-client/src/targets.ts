/**
 * Interop targets and the ALPN set worth asking about.
 *
 * Only publicly-announced, self-identifying MoQ endpoints and generic control hosts appear here.
 */

export interface RelayTarget {
  /** Short id used on the CLI and in the report. */
  id: string;
  host: string;
  port: number;
  /** Why this endpoint is in the matrix — kept so a stale target is obvious rather than mysterious. */
  note: string;
  /** A control host is a known-good QUIC server used to prove the prober works, not a MoQ relay. */
  control?: boolean;
}

/**
 * The ALPN identifiers a MoQ peer might offer.
 *
 * `moqt-NN` is the draft-NN ALPN token from MoQ Transport §3.1 (ALPN-carried version negotiation).
 * `moq-00` is the pre-`moqt-` token still served by some long-lived deployments.
 * WAVE's own relay advertises 20..7 (`MOQ_DRAFT_SUPPORTED` in wrangler.toml, #212 E0), so a
 * multi-version offer is the normal case, not an exotic one.
 */
export const MOQ_ALPN_CANDIDATES = [
  'moqt-20', // draft-20, published 2026-08-31 — this relay's preferred draft as of #212 E0
  'moqt-19', // draft-19, published 2026-07-06
  'moqt-18',
  'moqt-17',
  'moqt-16',
  'moqt-11',
  'moqt-07',
  'moq-00',
] as const;

/** `h3` is the control: any live QUIC server answers it, so it separates "peer said no" from "we broke". */
export const CONTROL_ALPNS = ['h3'] as const;

export const RELAY_TARGETS: RelayTarget[] = [
  {
    id: 'cf-interop',
    host: 'interop-relay.cloudflare.mediaoverquic.com',
    port: 443,
    note: 'public MoQ interop relay announced for community interop testing',
  },
  {
    id: 'moq-dev',
    host: 'moq.dev',
    port: 443,
    note: 'public MoQ project site — probed to see whether the apex also fronts a relay',
  },
  {
    id: 'control-cloudflare',
    host: 'cloudflare.com',
    port: 443,
    note: 'control: a QUIC/HTTP-3 server that is definitively NOT a MoQ relay',
    control: true,
  },
  {
    id: 'control-google',
    host: 'www.google.com',
    port: 443,
    note: 'second control on independent infrastructure',
    control: true,
  },
];

export function resolveTarget(idOrHost: string): RelayTarget {
  const known = RELAY_TARGETS.find((t) => t.id === idOrHost || t.host === idOrHost);
  if (known) return known;
  const [host, port] = idOrHost.split(':');
  return { id: idOrHost, host, port: port ? Number(port) : 443, note: 'ad-hoc target from the command line' };
}
