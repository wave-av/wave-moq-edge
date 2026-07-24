import { describe, it, expect, vi } from 'vitest';
import { MOQSessionDurableObject } from '../moq-session-do';
import { WS_KIND } from '../src/moq-wire';

// ── Minimal fakes for DurableObjectState / WebSocket ────────────────────────────────────────────────
// The DO's fetch()/handleWebSocket() path needs the full CF DO surface; these two fixes live entirely
// in private methods reachable via reflection (`(instance as any)`), so we build only the state surface
// those methods actually touch (storage get/put/delete, waitUntil, id.toString, getWebSockets).

function fakeState() {
  const store = new Map<string, unknown>();
  return {
    id: { toString: () => 'track-key' },
    storage: {
      get: vi.fn(async (key: string) => store.get(key)),
      put: vi.fn(async (key: string, val: unknown) => {
        store.set(key, val);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
    },
    waitUntil: vi.fn((p: Promise<unknown>) => {
      // real DO waitUntil doesn't block the caller; swallow rejections like production would (fire-and-forget)
      void p.catch(() => {});
    }),
    acceptWebSocket: vi.fn(),
    getWebSockets: vi.fn(() => []),
  } as unknown as DurableObjectState;
}

const fakeEnv = {
  MOQ_TRACK_REGISTRY: {} as KVNamespace,
  MOQ_RECORDINGS: {} as R2Bucket,
  ENVIRONMENT: 'test',
  MOQ_DRAFT_VERSION: '18',
  MAX_SUBSCRIBERS_PER_TRACK: '1000',
  MAX_OBJECT_SIZE_BYTES: '1048576',
  LOG_LEVEL: 'error',
  // recording provisioned so recordingEnabled()/enqueueRecord() are live, not inert:
  GATEWAY_BASE_URL: 'https://gateway.example',
  WAVE_SERVICE_TOKEN: 'svc-token',
  MOQ_RECORDINGS_BUCKET: 'recordings-bucket',
};

function makeDO() {
  return new MOQSessionDurableObject(fakeState(), fakeEnv as never) as unknown as Record<string, any>;
}

function fakeWs(overrides: Record<string, unknown> = {}) {
  return {
    send: vi.fn(),
    readyState: 1,
    bufferedAmount: 0,
    ...overrides,
  };
}

const MAX_SEND_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_QUEUE = 64;

describe('send() backpressure survival (FIX 1)', () => {
  it('drops an OBJECT frame when ws.send throws and the socket is still open — does NOT self-close', () => {
    const instance = makeDO();
    const ws = fakeWs({
      send: vi.fn(() => {
        throw new Error('backpressure');
      }),
      readyState: 1,
    });
    instance.sockets.set('sub-1', ws);
    const onCloseSpy = vi.spyOn(instance, 'onClose').mockResolvedValue(undefined);

    instance.send('sub-1', WS_KIND.OBJECT, new Uint8Array([1, 2, 3]));

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(onCloseSpy).not.toHaveBeenCalled();
    expect(instance.sendDrops).toBe(1);
    expect(instance.sockets.has('sub-1')).toBe(true); // session survives
  });

  it('self-closes on a CONTROL frame throw even when the socket is still open', () => {
    const instance = makeDO();
    const ws = fakeWs({
      send: vi.fn(() => {
        throw new Error('gone');
      }),
      readyState: 1,
    });
    instance.sockets.set('sub-2', ws);
    const onCloseSpy = vi.spyOn(instance, 'onClose').mockResolvedValue(undefined);

    instance.send('sub-2', WS_KIND.CONTROL, new Uint8Array([9]));

    expect(onCloseSpy).toHaveBeenCalledWith('sub-2');
  });

  it('self-closes on an OBJECT frame throw when the socket is no longer open (readyState !== 1)', () => {
    const instance = makeDO();
    const ws = fakeWs({
      send: vi.fn(() => {
        throw new Error('closed');
      }),
      readyState: 3, // CLOSED
    });
    instance.sockets.set('sub-3', ws);
    const onCloseSpy = vi.spyOn(instance, 'onClose').mockResolvedValue(undefined);

    instance.send('sub-3', WS_KIND.OBJECT, new Uint8Array([1]));

    expect(onCloseSpy).toHaveBeenCalledWith('sub-3');
  });

  it('drops an OBJECT frame without calling ws.send when bufferedAmount exceeds MAX_SEND_BUFFER_BYTES', () => {
    const instance = makeDO();
    const ws = fakeWs({ bufferedAmount: MAX_SEND_BUFFER_BYTES + 1 });
    instance.sockets.set('sub-4', ws);

    instance.send('sub-4', WS_KIND.OBJECT, new Uint8Array([1, 2, 3]));

    expect(ws.send).not.toHaveBeenCalled();
    expect(instance.sendDrops).toBe(1);
  });

  it('still sends normally when bufferedAmount is under the threshold', () => {
    const instance = makeDO();
    const ws = fakeWs({ bufferedAmount: 1024 });
    instance.sockets.set('sub-5', ws);

    instance.send('sub-5', WS_KIND.OBJECT, new Uint8Array([7]));

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(instance.sendDrops).toBe(0);
  });
});

describe('enqueueRecord() bounded serial queue (FIX 2)', () => {
  const session = {
    trackKey: 'track-key',
    publisherSessionId: 'pub-1',
    publisherOrg: 'org-1',
    publisherProtocol: null,
    subscriberCount: 0,
    publisherStartedAt: new Date().toISOString(),
    lastActivityAt: null,
    groupsSeen: 0,
    objectsSeen: 0,
  };

  it('runs records SERIALLY, preserving enqueue order, never concurrently', async () => {
    const instance = makeDO();
    const order: number[] = [];
    const releases: Array<() => void> = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    instance.recordPayload = vi.fn((_s: unknown, payload: Uint8Array) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      return new Promise<void>((resolve) => {
        releases.push(() => {
          order.push(payload[0]);
          concurrent--;
          resolve();
        });
      });
    });

    instance.enqueueRecord(session, new Uint8Array([1]));
    instance.enqueueRecord(session, new Uint8Array([2]));
    instance.enqueueRecord(session, new Uint8Array([3]));

    // Only the first should have started (chain is serial) — recordPayload called once so far.
    await Promise.resolve();
    await Promise.resolve();
    expect(instance.recordPayload).toHaveBeenCalledTimes(1);
    expect(maxConcurrent).toBe(1);

    releases[0]();
    // allow the .then() chain to settle call #1 and schedule call #2
    await new Promise((r) => setTimeout(r, 0));
    expect(instance.recordPayload).toHaveBeenCalledTimes(2);

    releases[1]();
    await new Promise((r) => setTimeout(r, 0));
    expect(instance.recordPayload).toHaveBeenCalledTimes(3);

    releases[2]();
    await new Promise((r) => setTimeout(r, 0));

    expect(order).toEqual([1, 2, 3]); // strict FIFO order preserved despite async completion
    expect(maxConcurrent).toBe(1); // never more than one in flight
  });

  it('drops records once the queue reaches MAX_RECORD_QUEUE, without touching recordPayload for the drop', () => {
    const instance = makeDO();
    instance.recordPayload = vi.fn(() => new Promise<void>(() => {})); // never resolves — simulate backlog
    for (let i = 0; i < MAX_RECORD_QUEUE; i++) {
      instance.enqueueRecord(session, new Uint8Array([i]));
    }
    expect(instance.recordDepth).toBe(MAX_RECORD_QUEUE);
    const callsBefore = instance.recordPayload.mock.calls.length;

    instance.enqueueRecord(session, new Uint8Array([255])); // over the bound

    expect(instance.recordDropped).toBe(1);
    expect(instance.recordDepth).toBe(MAX_RECORD_QUEUE); // unchanged — the drop never entered the chain
    expect(instance.recordPayload.mock.calls.length).toBe(callsBefore);
  });

  it('is a no-op when recording is not provisioned for the session', () => {
    const instance = makeDO();
    instance.recordPayload = vi.fn();
    const unprovisioned = { ...session, publisherOrg: null };
    instance.enqueueRecord(unprovisioned, new Uint8Array([1]));
    expect(instance.recordPayload).not.toHaveBeenCalled();
    expect(instance.recordDepth).toBe(0);
  });

  it('drains in-flight records via `await this.recordTail` BEFORE finalizeAndRegister runs at publish_end', async () => {
    const instance = makeDO();
    instance.session = { ...session };
    let recordResolved = false;
    instance.recordPayload = vi.fn(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            recordResolved = true;
            resolve();
          }, 15),
        ),
    );
    let finalizeCalledWithRecordSettled: boolean | null = null;
    instance.finalizeAndRegister = vi.fn(async () => {
      finalizeCalledWithRecordSettled = recordResolved;
    });

    instance.enqueueRecord(instance.session, new Uint8Array([1]));
    // publish_end drives: await this.recordTail; await this.finalizeAndRegister(...)
    await instance.applyEvents([{ kind: 'publish_end', sessionId: 'pub-1', bytes: 0 }]);

    expect(instance.finalizeAndRegister).toHaveBeenCalledTimes(1);
    expect(finalizeCalledWithRecordSettled).toBe(true); // the record settled BEFORE finalize ran
  });
});
