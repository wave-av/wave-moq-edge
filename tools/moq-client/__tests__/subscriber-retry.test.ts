/**
 * Unit tests for the E0 16-track bench's publisher-first subscriber retry (src/subscriber-retry.ts).
 *
 * Network-free: `open` and `sleep` are injected fakes, so these assert the RETRY/ORDERING behaviour
 * itself — never a real transport-connect or a real timer.
 *
 * Regression coverage for the 2026-08-31 live run: all 4 canary tracks failed identically —
 * role=subscriber stage=transport-connect, `relay http 404: {"title":"Track not found or no active
 * publisher"...}` — because the subscriber connected before its publisher had announced. These tests
 * assert the subscriber's connect is deferred/retried until the publisher-ready condition (here,
 * simulated as "the Nth open attempt no longer 404s") is met.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  SUBSCRIBER_RETRY_MAX_ATTEMPTS,
  isPublisherNotYetAnnounced,
  openSubscriberWithRetry,
  retryDelayMs,
  type OpenTransportFn,
} from '../src/subscriber-retry.ts';
import type { Transport } from '../src/transport.ts';

function fakeTransport(): Transport {
  return {
    kind: 'websocket',
    alpn: null,
    send: () => {},
    receive: async () => null,
    close: () => {},
    closeInfo: new Promise(() => {}), // never resolves — irrelevant to these tests
  };
}

const NOT_ANNOUNCED_404 = new Error('relay http 404: {"title":"Track not found or no active publisher","status":404}');

describe('isPublisherNotYetAnnounced', () => {
  it('matches the exact relay-404 shape openTransport() throws', () => {
    expect(isPublisherNotYetAnnounced(NOT_ANNOUNCED_404)).toBe(true);
  });

  it('does not match other transport-connect failures (auth, 5xx, network)', () => {
    expect(isPublisherNotYetAnnounced(new Error('relay http 401: unauthorized'))).toBe(false);
    expect(isPublisherNotYetAnnounced(new Error('relay http 500: internal error'))).toBe(false);
    expect(isPublisherNotYetAnnounced(new Error('websocket connection failed before open (ECONNREFUSED)'))).toBe(false);
  });

  it('does not match a non-Error rejection reason that is not a 404 message', () => {
    expect(isPublisherNotYetAnnounced('boom, not an Error and not a 404')).toBe(false);
  });
});

describe('retryDelayMs', () => {
  it('is bounded — never grows without limit', () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      expect(retryDelayMs(attempt)).toBeLessThanOrEqual(2_000);
      expect(retryDelayMs(attempt)).toBeGreaterThan(0);
    }
  });

  it('increases (or holds at the cap) with each attempt — a real backoff, not a flat retry', () => {
    expect(retryDelayMs(2)).toBeGreaterThanOrEqual(retryDelayMs(1));
    expect(retryDelayMs(3)).toBeGreaterThanOrEqual(retryDelayMs(2));
  });
});

describe('openSubscriberWithRetry', () => {
  it('connects on the first attempt when the publisher is already announced — no retry, no sleep', async () => {
    const transport = fakeTransport();
    const open: OpenTransportFn = vi.fn(async () => transport);
    const sleep = vi.fn(async () => {});

    const result = await openSubscriberWithRetry(open, 'wss://relay/v1/subscribe/ns/track', 'tok', 5, sleep);

    expect(result).toBe(transport);
    expect(open).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  /**
   * THE regression case: a publisher that becomes ready after N ticks (here, N=3 — the first two
   * subscriber connect attempts 404 because the publisher hasn't announced yet; the third succeeds).
   * Asserts the subscriber's connect is deferred/retried until that condition is met, exactly what the
   * live 4/4-canary-404 failure needed.
   */
  it('retries on a simulated publisher-not-yet-announced 404, then succeeds once the publisher is ready', async () => {
    const transport = fakeTransport();
    let attempts = 0;
    const open: OpenTransportFn = vi.fn(async () => {
      attempts++;
      if (attempts < 3) throw new Error('relay http 404: {"title":"Track not found or no active publisher"}');
      return transport;
    });
    const sleepCalls: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
    });

    const result = await openSubscriberWithRetry(open, 'wss://relay/v1/subscribe/ns/track', 'tok', 5, sleep);

    expect(result).toBe(transport);
    expect(open).toHaveBeenCalledTimes(3);
    // Slept exactly twice — once after each of the two 404s, never after the eventual success.
    expect(sleepCalls).toHaveLength(2);
    expect(sleepCalls[0]).toBeGreaterThan(0);
    expect(sleepCalls[1]).toBeGreaterThanOrEqual(sleepCalls[0]);
  });

  it('does NOT retry a non-404 failure (auth rejection) — rethrows on the first attempt', async () => {
    const open: OpenTransportFn = vi.fn(async () => {
      throw new Error('relay http 401: {"title":"unauthorized"}');
    });
    const sleep = vi.fn(async () => {});

    await expect(openSubscriberWithRetry(open, 'wss://relay/v1/subscribe/ns/track', 'tok', 5, sleep)).rejects.toThrow(
      /relay http 401/,
    );
    expect(open).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after the bounded max attempts if the publisher never becomes ready — fits inside the per-track ceiling', async () => {
    const open: OpenTransportFn = vi.fn(async () => {
      throw new Error('relay http 404: {"title":"Track not found or no active publisher"}');
    });
    const sleep = vi.fn(async () => {});

    await expect(
      openSubscriberWithRetry(open, 'wss://relay/v1/subscribe/ns/track', 'tok', SUBSCRIBER_RETRY_MAX_ATTEMPTS, sleep),
    ).rejects.toThrow(/relay http 404/);
    expect(open).toHaveBeenCalledTimes(SUBSCRIBER_RETRY_MAX_ATTEMPTS);
    // Slept between every attempt but the last — never an extra sleep after giving up.
    expect(sleep).toHaveBeenCalledTimes(SUBSCRIBER_RETRY_MAX_ATTEMPTS - 1);
  });

  it('defaults to SUBSCRIBER_RETRY_MAX_ATTEMPTS when maxAttempts is not supplied', async () => {
    const open: OpenTransportFn = vi.fn(async () => {
      throw new Error('relay http 404: {"title":"Track not found or no active publisher"}');
    });
    const sleep = vi.fn(async () => {});

    await expect(openSubscriberWithRetry(open, 'wss://relay/v1/subscribe/ns/track', 'tok', undefined, sleep)).rejects.toThrow();
    expect(open).toHaveBeenCalledTimes(SUBSCRIBER_RETRY_MAX_ATTEMPTS);
  });
});
