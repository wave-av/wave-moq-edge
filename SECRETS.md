# Secrets inventory & rotation cadence

> **Audited 2026-05-29.** One source of truth for what each secret does, where it's used, and how often it needs rotating. Keep this file up to date when you add/remove a secret.

## GitHub Actions secrets (CI / deploy)

| Secret | Purpose | Used by | Rotation cadence |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Worker deploys via wrangler-action | `deploy.yml` (env-aware: push main → `<proto>.wave.online`; push staging → `<proto>.staging.wave.online`) | Quarterly. Token scopes: Account · Workers Scripts: Edit, Workers KV Storage: Edit, Zone · Workers Routes: Edit. Mint at https://dash.cloudflare.com/profile/api-tokens |
| `CLOUDFLARE_ACCOUNT_ID` | Helper for wrangler-action (some commands accept it via env) | `deploy.yml` | Never rotates (it's an ID, not a secret — kept secret-form for consistency) |

> 🚧 **Long-term:** these tokens will be replaced by Doppler→GH sync with auto-rotation (wave-foundation task #111). Until then, set a calendar reminder for the next rotation.

## Worker runtime secrets (set via `wrangler secret put`)

> These are bound to the Worker at deploy time, NOT GitHub Actions secrets. They're set per-environment (production, staging) via `wrangler secret put <NAME> --env production`.

| Secret | Purpose | Source | Rotation cadence |
|---|---|---|---|
| _(this spoke is THIN — auth is the gateway's job; no auth secrets needed here)_ | | | |

If this spoke needs a product-specific secret (e.g. a webhook signing key it terminates ITSELF), add a row here. A leaked-anon-JWT incident exists in this program from inlining a key in a `wrangler.toml` — **never** repeat it. Use `wrangler secret put`, never `[vars]`.

## Local dev secrets (`.dev.vars`)

`.dev.vars` is in `.gitignore`. Use `.dev.vars.example` as the template (committed, contains placeholders). When a new secret is added, update both `.dev.vars.example` and this file.

## Rotation runbook

For `CLOUDFLARE_API_TOKEN`:

1. Open https://dash.cloudflare.com/profile/api-tokens
2. Create token with template: "Edit Cloudflare Workers" → restrict to this account + this spoke's zone (`wave.online`)
3. Copy token. Set in this repo:
   ```bash
   gh secret set CLOUDFLARE_API_TOKEN -R wave-av/$(basename $(pwd)) -b "<token>"
   ```
4. Verify the next push triggers a successful deploy (`deploy.yml` will skip with a notice if the secret is missing).
5. Delete the old token in the CF dashboard.

## Inventory hygiene

When you ADD a secret: append a row above and update `.dev.vars.example` (if applicable).
When you REMOVE a secret: add to a "Removed" section below with the cleanup command, then delete after one release cycle.

## Removed secrets

_(none currently)_

## See also

- `wave-foundation/docs/conventions/url-naming.md` — what `deploy.yml` routes to
- `wave-foundation/scripts/consume.sh` — vendoring shared rules
- This repo's `wrangler.toml` — the `# SECRETS` block lists every runtime secret the worker expects
