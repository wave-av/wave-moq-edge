#!/usr/bin/env node
// scripts/ci/resolve-deploy-host.mjs — print the bare hostname of the first `routes[].pattern`
// declared under `[env.<ENV_NAME>]` in wrangler.toml, for a given env name ("production" or
// "staging"). Exits 1 with empty stdout if that section or a route pattern is absent (e.g. a
// gated draft with no live routes, or a spoke that has not yet added a route for that env).
//
// Ported from wave-spoke-template (ci/deploy-ordering, PR #69) with ONE extension: some spokes'
// wrangler.toml has NO `[env.*]` blocks at all — a single-config, fixed-`--name`-deploy spoke (the
// wrangler env-fork bug means an `--env` deploy would silently fork a second worker, so deploy.yml
// pins `--name` instead and there is no `[env.production]` section to look under). The route
// pattern for such a spoke lives at the TOP LEVEL of wrangler.toml, before any `[table]` header
// (config-no-silent-noop: a `routes` key placed after a `[table]` header is parsed as that table's
// field and silently ignored — see wave-bridge-edge/wave-media-edge wrangler.toml comments). When
// wrangler.toml declares no `[env.*]` section AT ALL, fall back to that top-level route for
// envName === "production" only (there is no separate staging domain on these single-config spokes).
//
// Why this exists: .github/workflows/deploy.yml's post-deploy verify step needs to know which live
// host to poll after a deploy, but every spoke names its own domain differently. Deriving the host
// from wrangler.toml itself (the ONE place guaranteed correct, because it is what wrangler actually
// deployed) avoids hardcoding a guess per spoke.
//
// Line-based (not one mega-regex) on purpose: wrangler.toml is full of comments that mention
// `[env.production]` in prose — a naive regex scan of the raw text matches those comments too.
// Parsing line-by-line and skipping `#`-comment lines avoids that trap.
//
// Usage: node scripts/ci/resolve-deploy-host.mjs <production|staging>

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
export const WRANGLER_TOML = resolve(__dir, "../../wrangler.toml");

/** Pure: given the raw wrangler.toml text and an env name, return the first route hostname under
 *  `[env.<envName>]` (and its live, non-commented subsections, e.g. `[env.<envName>.vars]`), or the
 *  top-level route (single-config, fixed-`--name` spokes with NO `[env.*]` blocks at all — see
 *  header comment) when envName is "production", or null if neither is present. Ignores
 *  `#`-commented lines entirely (documentation-only example blocks don't count). */
export function resolveDeployHost(tomlSrc, envName) {
  const lines = tomlSrc.split("\n");
  const sectionHeader = `[env.${envName}]`;
  const subsectionPrefix = `[env.${envName}.`;
  let inSection = false;
  let sawEnvHeader = false;
  let inAnyTable = false;
  let topLevelHost = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue; // skip comments/documentation-only examples
    if (line.startsWith("[env.")) sawEnvHeader = true;
    if (line === sectionHeader) {
      inSection = true;
      continue;
    }
    if (inSection && line.startsWith("[")) {
      // A new section header: stay "in" only if it's a live subsection of this same env.
      inSection = line.startsWith(subsectionPrefix);
      continue;
    }
    if (inSection) {
      const m = /pattern\s*=\s*"([^"/]+)/.exec(line);
      if (m) return m[1];
    }
    if (line.startsWith("[")) {
      inAnyTable = true;
      continue;
    }
    if (!inAnyTable && topLevelHost === null) {
      const m = /pattern\s*=\s*"([^"/]+)/.exec(line);
      if (m) topLevelHost = m[1];
    }
  }
  if (!sawEnvHeader && envName === "production" && topLevelHost) return topLevelHost;
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const envName = process.argv[2];
  if (envName !== "production" && envName !== "staging") {
    console.error("usage: resolve-deploy-host.mjs <production|staging>");
    process.exit(1);
  }
  const src = readFileSync(WRANGLER_TOML, "utf8");
  const host = resolveDeployHost(src, envName);
  if (!host) process.exit(1);
  process.stdout.write(host);
}
