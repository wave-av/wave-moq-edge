/**
 * Unit coverage for the STEADY-STATE latency gate on runPublish (PublishOpts.onAnnounced / startSignal).
 *
 * The E0 16-track bench measured p50=3312ms / p95=6235ms on a live run whose per-hop floor (minMs) was
 * 43-59ms — a ~50x inflation. Root cause: the publisher sent objects from t=0 while the subscriber
 * attached ~4s later, so the relay delivered those early objects late. The fix gates the publisher's
 * object stream on the subscriber being attached: runPublish announces (PUBLISH_NAMESPACE), fires
 * onAnnounced, then AWAITS startSignal before emitting a single object. These tests pin that contract
 * without a network round trip, by counting send() frames around the gate.
 */
import { describe, expect, it } from 'vitest';
import { runPublish } from '../src/session.ts';
import type { Transport } from '../src/transport.ts';

function countingTransport(sends: Uint8Array[]): Transport {
  return {
    kind: 'websocket',
    alpn: null,
    send: (b: Uint8Array) => {
      sends.push(b);
    },
    receive: async () => null,
    close: () => {},
    closeInfo: new Promise(() => {}), // never resolves — these tests don't exercise transport close
  };
}

describe('runPublish — steady-state send gate', () => {
  it('fires onAnnounced and sends only the 2 control frames, holding every object until startSignal resolves', async () => {
    const sends: Uint8Array[] = [];
    const t = countingTransport(sends);
    let announced = false;
    let resolveStart!: () => void;
    const startSignal = new Promise<void>((r) => {
      resolveStart = r;
    });

    const pub = runPublish({
      transport: t,
      peer: 'wss://relay.example/pub',
      namespace: ['ns'],
      track: 'trk',
      count: 5,
      intervalMs: 0,
      payloadBytes: 16,
      onAnnounced: () => {
        announced = true;
      },
      startSignal,
    });

    // runPublish has no await before the gate, so by the time the call returns its promise it has
    // already sent SETUP + PUBLISH_NAMESPACE, fired onAnnounced, and parked on startSignal.
    expect(announced).toBe(true);
    expect(sends.length).toBe(2); // exactly the two control frames — NOT one object yet
    const beforeRelease = sends.length;

    resolveStart();
    await pub;

    // Gate released → the 5 object frames flow. 2 control + 5 objects.
    expect(sends.length).toBe(2 + 5);
    expect(sends.length).toBeGreaterThan(beforeRelease);
  });

  it('without startSignal, emits objects immediately after announce (legacy path unchanged)', async () => {
    const sends: Uint8Array[] = [];
    const t = countingTransport(sends);
    await runPublish({
      transport: t,
      peer: 'wss://relay.example/pub',
      namespace: ['ns'],
      track: 'trk',
      count: 3,
      intervalMs: 0,
      payloadBytes: 16,
    });
    expect(sends.length).toBe(2 + 3);
  });
});
