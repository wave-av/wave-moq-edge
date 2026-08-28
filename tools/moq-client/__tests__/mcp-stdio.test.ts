/**
 * Real end-to-end stdio JSON-RPC test for `tools/moq-client/mcp.ts` — spawns the ACTUAL server
 * process (not `handleRequest` in-process, which is what `--self-test` already covers) and talks
 * to it over real stdin/stdout pipes. This is a regression test for two bugs found while building
 * this phase's MCP receipt, neither of which the pre-existing `--self-test` could catch because it
 * never exercises `runServer()`:
 *   1. `createInterface` was used but never imported from `node:readline` — server mode crashed
 *      immediately on every real invocation.
 *   2. `main()` called `runServer()` without awaiting it, then resolved; the outer
 *      `main().then((code) => process.exit(code))` fired `process.exit(0)` before `readline` got a
 *      turn on the event loop, so every request was silently dropped even after bug 1 was fixed.
 * A single request over a real pipe reproduced both 100% of the time before the fix.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = join(HERE, '..', 'mcp.ts');

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Spawn the real MCP server, send `requests` over real stdin, collect exactly
 *  `requests.length` newline-delimited JSON-RPC responses from real stdout, then kill it. */
function runOverRealStdio(requests: object[], timeoutMs = 10_000): Promise<JsonRpcResponse[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--experimental-transform-types', MCP_ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    const responses: JsonRpcResponse[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out waiting for ${requests.length} response(s); got ${responses.length}`));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) responses.push(JSON.parse(line) as JsonRpcResponse);
      }
      if (responses.length >= requests.length) {
        clearTimeout(timer);
        child.kill();
        resolve(responses);
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`);
  });
}

describe('mcp.ts — real stdio JSON-RPC server (not in-process --self-test)', () => {
  it('answers a single initialize request over a real pipe without hanging or dropping it', async () => {
    const [res] = await runOverRealStdio([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }]);
    expect(res.result).toMatchObject({ protocolVersion: '2024-11-05' });
  }, 15_000);

  it('answers tools/list and a real tools/call for tai_map, matching the CLI-visible groupId', async () => {
    const responses = await runOverRealStdio([
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'tai_map',
          arguments: { taiNs: '1893456789000000000', rate: '30000/1001', frameIndex: '42' },
        },
      },
    ]);
    const list = responses.find((r) => r.id === 1);
    const names = (list?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toContain('tai_map');

    const call = responses.find((r) => r.id === 2);
    const content = (call?.result as { content: Array<{ type: string; text: string }> }).content[0];
    const report = JSON.parse(content.text) as { groupId: string };
    // Same deterministic value the E1-proven pure function produces directly — matches this file's
    // sibling CLI verb for identical inputs (no drift between the two internal faces).
    expect(report.groupId).toBe('56746956713');
  }, 15_000);
});
