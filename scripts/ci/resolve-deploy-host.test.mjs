// scripts/ci/resolve-deploy-host.test.mjs — node:test unit coverage for resolveDeployHost()'s pure
// wrangler.toml parsing. No filesystem, no network. Run via `node --test scripts/ci/*.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDeployHost } from "./resolve-deploy-host.mjs";

test("finds the route hostname under [env.production]", () => {
  const toml = `
name = "wave-srt-spoke"
[env.production]
name = "wave-srt-spoke"
routes = [
  { pattern = "srt.wave.online/*", zone_name = "wave.online" }
]
`;
  assert.equal(resolveDeployHost(toml, "production"), "srt.wave.online");
});

test("skips past subsections like [env.production.vars] to find the route", () => {
  const toml = `
[env.production]
routes = [
  { pattern = "wave.online/*", zone_name = "wave.online" }
]
[env.production.observability]
enabled = true
[env.production.vars]
ORIGIN_URL = "https://api.wave.online"
`;
  assert.equal(resolveDeployHost(toml, "production"), "wave.online");
});

test("does not bleed into a different env's section", () => {
  const toml = `
[env.production]
routes = [
  { pattern = "wave.online/*", zone_name = "wave.online" }
]
[env.staging]
routes = [
  { pattern = "staging.wave.online/*", zone_name = "wave.online" }
]
`;
  assert.equal(resolveDeployHost(toml, "production"), "wave.online");
  assert.equal(resolveDeployHost(toml, "staging"), "staging.wave.online");
});

test("returns null when the env section is absent (e.g. the draft template)", () => {
  const toml = `name = "wave-spoke-template"\n[vars]\nWAVE_PRODUCT = "REPLACE_WITH_CATALOG_SKU"\n`;
  assert.equal(resolveDeployHost(toml, "production"), null);
  assert.equal(resolveDeployHost(toml, "staging"), null);
});

test("returns null when the section exists but has no routes", () => {
  const toml = `[env.production]\nname = "x"\n`;
  assert.equal(resolveDeployHost(toml, "production"), null);
});

test("ignores a commented-out mention of the section header in prose", () => {
  const toml = `
# Named envs don't inherit top-level vars; the [env.production] copy further down restates them.
[env.production]
routes = [
  { pattern = "wave.online/*", zone_name = "wave.online" }
]
`;
  assert.equal(resolveDeployHost(toml, "production"), "wave.online");
});

test("ignores a fully commented-out example section (draft template documentation)", () => {
  const toml = `
#   [env.production]
#   route = { pattern = "<proto>.wave.online/*", zone_name = "wave.online" }
`;
  assert.equal(resolveDeployHost(toml, "production"), null);
});

test("supports the singular `route = { ... }` form (not just `routes = [...]`)", () => {
  const toml = `
[env.production]
route = { pattern = "moq.wave.online/*", zone_name = "wave.online" }
`;
  assert.equal(resolveDeployHost(toml, "production"), "moq.wave.online");
});

test("falls back to the top-level route when there are no [env.*] sections at all (single-config, fixed --name deploy spoke)", () => {
  const toml = `
name = "wave-media-edge"
main = "src/index.ts"
workers_dev = false
routes = [{ pattern = "media.wave.online", custom_domain = true }]
[vars]
WAVE_PRODUCT = "media"
`;
  assert.equal(resolveDeployHost(toml, "production"), "media.wave.online");
  assert.equal(resolveDeployHost(toml, "staging"), null);
});

test("top-level fallback ignores a route that appears only inside a later [table] (config-no-silent-noop)", () => {
  const toml = `
name = "wave-example"
[vars]
FOO = "bar"
routes = [{ pattern = "should-not-count.wave.online", custom_domain = true }]
`;
  assert.equal(resolveDeployHost(toml, "production"), null);
});
