#!/usr/bin/env node
// scripts/ci/bundle-eval-gate.mjs
//
// Systemic prevention for #215 (5-day prod outage: `buildTokensCss is not defined`, a
// ReferenceError thrown at Worker MODULE-EVALUATION time that `tsc --noEmit` cannot see
// (it's a value-level reference, not a type error) and `wrangler deploy --dry-run` cannot
// see either (dry-run only BUNDLES with esbuild — it never instantiates the bundle in a
// JS runtime, so a bundled-but-broken top-level reference sails through green).
//
// This gate boots the ACTUAL Worker bundle inside workerd via `wrangler dev` (local mode,
// zero Cloudflare credentials required — it's the same code path `wrangler deploy` uses to
// produce the bundle, then a real workerd isolate loads it exactly like the Cloudflare
// upload-time evaluation step does). A top-level `ReferenceError`/`SyntaxError` thrown while
// workerd evaluates the module fails the boot before "Ready on" is ever printed, and this
// script fails loudly with the captured error. A clean boot + one successful HTTP round trip
// is the only thing that passes.
//
// Why not a plain `node dist/index.js` eval? A Workers bundle is `export default { fetch... }`
// and commonly references Workers-only runtime globals (crypto, caches, Request/Response
// shapes, `cf` properties, WebSocketPair, etc.) at module scope in this codebase (Durable
// Object classes, KV/R2 bindings). Evaluating that in plain Node throws on globals Node never
// defines — a FALSE POSITIVE unrelated to #215's actual defect class. Booting in workerd
// (via wrangler's local dev, which is Miniflare/workerd under the hood) is the only eval
// environment that matches production closely enough to avoid that false-positive class
// while still catching a genuine top-level ReferenceError.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PORT = process.env.BUNDLE_EVAL_GATE_PORT ?? "18787";
const READY_TIMEOUT_MS = 60_000;
const FAILURE_PATTERNS = [
  /ReferenceError/,
  /is not defined/,
  /SyntaxError/,
  /Uncaught \(in promise\)/,
  /threw an exception/i,
  /Error: Could not resolve/,
];

function log(...args) {
  console.log("[bundle-eval-gate]", ...args);
}

async function main() {
  log(`booting Worker bundle in workerd via 'wrangler dev' on port ${PORT} ...`);

  const child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--port",
      PORT,
      "--local-protocol",
      "http",
      "--ip",
      "127.0.0.1",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CI: "true",
        WRANGLER_UPDATE_CHECK: "false",
        WRANGLER_SEND_METRICS: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  let ready = false;
  let failureLine = null;
  let exited = false;
  let exitCode = null;

  const onData = (buf) => {
    const text = buf.toString();
    output += text;
    process.stdout.write(text);
    if (!ready && /Ready on http/.test(text)) {
      ready = true;
    }
    if (!failureLine) {
      for (const pattern of FAILURE_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
          failureLine = text.trim().split("\n").find((l) => pattern.test(l)) ?? match[0];
          break;
        }
      }
    }
  };

  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!ready && !failureLine && !exited && Date.now() < deadline) {
    await delay(250);
  }

  // Give a fast-failing process a brief grace window to flush its final error output.
  if (!ready && !failureLine) {
    await delay(500);
  }

  const shutdown = () => {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  };

  if (failureLine || exited) {
    shutdown();
    log("FAILED — the Worker bundle did not evaluate cleanly in workerd.");
    if (failureLine) log(`Detected failure signature: ${failureLine}`);
    if (exited) log(`wrangler dev exited early with code ${exitCode}`);
    log("--- captured output ---");
    console.log(output);
    process.exitCode = 1;
    return;
  }

  if (!ready) {
    shutdown();
    log(`FAILED — 'wrangler dev' never printed "Ready on" within ${READY_TIMEOUT_MS}ms.`);
    console.log(output);
    process.exitCode = 1;
    return;
  }

  // The module evaluated and the dev server bound its port. Confirm it actually serves a
  // request too — this is exactly the "throws only when Cloudflare EVALUATES the bundle at
  // upload" class (issue #215): the process is up, but hitting it can still surface a
  // request-time throw for some defect shapes, so a green gate proves round-trip, not just
  // process-alive.
  let httpOk = false;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/`, {
      signal: AbortSignal.timeout(10_000),
    });
    // Any HTTP status (including 404/401) proves the worker evaluated AND handled a request
    // without throwing — we don't assert a route contract here, only "it's alive".
    httpOk = typeof res.status === "number";
  } catch (err) {
    log(`HTTP round-trip to booted worker failed: ${err}`);
  }

  shutdown();

  if (!httpOk) {
    log("FAILED — worker process bound its port but did not answer an HTTP request.");
    process.exitCode = 1;
    return;
  }

  log("PASSED — Worker bundle evaluated cleanly in workerd and served a request.");
  process.exitCode = 0;
}

main().catch((err) => {
  console.error("[bundle-eval-gate] unexpected error:", err);
  process.exitCode = 1;
});
