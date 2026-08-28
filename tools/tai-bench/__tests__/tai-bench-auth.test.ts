import { describe, it, expect, vi } from 'vitest';
import {
  requireBenchAuthToken,
  publishBenchObject,
  assertLoopbackOnly,
  BenchAuthError,
  encodeBenchObject,
  type BenchObjectInput,
  type PublishOptions,
} from '../src/tai-bench-publisher';
import { decodeSt2110TimingProperties } from '../../../src/st2110-timing-properties';
import { Reader } from '../../../src/moq-wire';
import { groupIdForInstant, rational } from '../../../src/tai-group-mapping';

// E1-TAI-BRIDGE P4 hard-gate: "An unauthenticated bench write must be refused. This is asserted by
// a test, not by configuration review." Every test in the first describe block proves the refusal
// happens BEFORE any socket I/O (via a call-count spy on `send`), not merely that a function throws.

const SECRET = 'bench-secret-do-not-use-in-prod';

function makeInput(): BenchObjectInput {
  const frameRate = rational(30, 1);
  const taiNs = 1_893_456_789_000_000_000n;
  return {
    trackAlias: 1n,
    objectId: 0n,
    groupId: groupIdForInstant(taiNs, frameRate),
    payload: new Uint8Array([1, 2, 3]),
    timing: { sourceTaiNs: taiNs, frameRate, clockDomain: 127 },
  };
}

describe('P4 hard-gate — unauthenticated bench write is refused, proven by test', () => {
  it('missing token: refused, socket.send is NEVER called', () => {
    const send = vi.fn();
    const opts: PublishOptions = { token: undefined, expectedSecret: SECRET, host: '127.0.0.1', port: 9999 };
    expect(() => publishBenchObject({ send }, makeInput(), opts)).toThrow(BenchAuthError);
    expect(send).not.toHaveBeenCalled();
  });

  it('wrong-scope / malformed token (bad prefix): refused, socket.send is NEVER called', () => {
    const send = vi.fn();
    const opts: PublishOptions = { token: 'Bearer garbage', expectedSecret: SECRET, host: '127.0.0.1', port: 9999 };
    expect(() => publishBenchObject({ send }, makeInput(), opts)).toThrow(BenchAuthError);
    expect(send).not.toHaveBeenCalled();
  });

  it('wrong secret: refused, socket.send is NEVER called', () => {
    const send = vi.fn();
    const opts: PublishOptions = {
      token: 'wave-token-v1.totally-not-the-secret',
      expectedSecret: SECRET,
      host: '127.0.0.1',
      port: 9999,
    };
    expect(() => publishBenchObject({ send }, makeInput(), opts)).toThrow(BenchAuthError);
    expect(send).not.toHaveBeenCalled();
  });

  it('non-loopback target: refused even with a VALID token, socket.send is NEVER called', () => {
    const send = vi.fn();
    const opts: PublishOptions = {
      token: `wave-token-v1.${SECRET}`,
      expectedSecret: SECRET,
      host: '203.0.113.5', // TEST-NET-3, deliberately not loopback
      port: 9999,
    };
    expect(() => publishBenchObject({ send }, makeInput(), opts)).toThrow(BenchAuthError);
    expect(send).not.toHaveBeenCalled();
  });

  it('valid token + loopback: accepted, socket.send is called exactly once with the encoded bytes', () => {
    const send = vi.fn();
    const opts: PublishOptions = { token: `wave-token-v1.${SECRET}`, expectedSecret: SECRET, host: '127.0.0.1', port: 9999 };
    const input = makeInput();
    publishBenchObject({ send }, input, opts);
    expect(send).toHaveBeenCalledTimes(1);
    const [bytes, port, host] = send.mock.calls[0];
    expect(port).toBe(9999);
    expect(host).toBe('127.0.0.1');
    expect(bytes).toEqual(encodeBenchObject(input));
  });

  it('requireBenchAuthToken rejects a token whose body differs only in length (no truncation match)', () => {
    expect(() => requireBenchAuthToken(`wave-token-v1.${SECRET}x`, SECRET)).toThrow(BenchAuthError);
    expect(() => requireBenchAuthToken(`wave-token-v1.${SECRET.slice(0, -1)}`, SECRET)).toThrow(BenchAuthError);
  });

  it('assertLoopbackOnly accepts 127.0.0.1, ::1, localhost and rejects everything else', () => {
    expect(() => assertLoopbackOnly('127.0.0.1')).not.toThrow();
    expect(() => assertLoopbackOnly('::1')).not.toThrow();
    expect(() => assertLoopbackOnly('localhost')).not.toThrow();
    expect(() => assertLoopbackOnly('0.0.0.0')).toThrow(BenchAuthError);
    expect(() => assertLoopbackOnly('moq.wave.online')).toThrow(BenchAuthError);
  });
});

describe('P4 — encoded bench object decodes back to the exact group id and timing bag', () => {
  it('round-trips trackAlias/groupId/objectId/payload/properties through the wire codec', () => {
    const input = makeInput();
    const bytes = encodeBenchObject(input);
    const r = new Reader(bytes);
    expect(r.varint()).toBe(input.trackAlias);
    expect(r.varint()).toBe(input.groupId);
    expect(r.varint()).toBe(input.objectId);
    expect(r.varintNum()).toBe(0); // MOQ_OBJECT_STATUS.NORMAL
    expect(r.bytesLP()).toEqual(input.payload);
    const properties = r.remaining > 0 ? r.bytesLP() : new Uint8Array(0);
    const decoded = decodeSt2110TimingProperties(properties);
    expect(decoded.sourceTaiNs).toBe(input.timing.sourceTaiNs);
    expect(decoded.frameRate).toEqual(input.timing.frameRate);
    expect(decoded.clockDomain).toBe(input.timing.clockDomain);
  });
});
