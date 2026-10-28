# wave-moq-edge on Buildkite (WAVE-30114..30117)

Pipeline `wave/wave-moq-edge`. Its settings step runs `.buildkite/upload.sh`, which uploads
`pipeline.yml` from the commit being built (`--no-interpolation`). GitHub Actions is not used for CI or
deploys. Queue: `fpc-isolated` for every step (never `fpc-isolated-secrets` / `master-pc-isolated`).

## Steps

| key | runs on | credential |
|---|---|---|
| `guard-gitleaks` | every build | none |
| `lint` | every build | none (public npm devDeps only) |
| `config-check` | every build | none: asserts `workers_dev = false`, `preview_urls = false` and a route for `env.staging` + `env.production`, then `wrangler deploy --dry-run --no-bundle` per env with wrangler 4.95.0 |
| `deploy-staging` | main push only | `CF_MOQ_EDGE_DEPLOY_TOKEN`, `WAVE_REGISTRY_READ_TOKEN` |
| `verify-staging` | main push only | `CF_MOQ_EDGE_DEPLOY_TOKEN` |
| `production-approval` (block) | main push only | n/a, a person unblocks |
| `deploy-production` | main push only | `CF_MOQ_EDGE_DEPLOY_TOKEN`, `WAVE_REGISTRY_READ_TOKEN` |
| `verify-production` | main push only | `CF_MOQ_EDGE_DEPLOY_TOKEN` |

"main push only" = `build.branch == "main" && build.pull_request.id == null && build.source == "webhook" && build.tag == null`
in the YAML, plus the host broker's main-only trust gate, plus `moq_require_main_push` in the scripts
(branch, PR, source, tag, and the commit must be an ancestor of `origin/main`).

## Credentials

No credential appears in `pipeline.yml`. The host job-secrets broker (Doppler `wave/bkjobs`) exports
them only for the step keys above, `main-only` policy, repo `wave-av/wave-moq-edge`. PR and branch builds
get nothing.

- `CF_MOQ_EDGE_DEPLOY_TOKEN`: Cloudflare API token scoped to this account only (Workers Scripts edit,
  Workers Routes edit for the wave.online zone routes). The scripts resolve the account id from it
  (it must see exactly one account), keep it in a non-exported variable, send it to curl through stdin,
  and give it to the one `wrangler deploy` process as `CLOUDFLARE_API_TOKEN`. A job that already has
  `CLOUDFLARE_API_TOKEN` set is refused.
- `WAVE_REGISTRY_READ_TOKEN`: Verdaccio read for `@wave-av/spoke-chassis` / `@wave-av/content-hash`,
  handed to one `npm ci --ignore-scripts` process, then dropped. The job rewrites the lockfile's GitHub
  Packages tarball URLs to Verdaccio; integrity hashes are unchanged.

## Rollback

`deploy-<env>` records the active version as build meta-data `moq-prev-version-<env>` before
deploying. A failed deploy or verify redeploys that version at 100% (`moq_rollback` in
`scripts/lib.sh`, Workers deployments API) and confirms it is active. By hand:
`wrangler rollback <version-id> --env <staging|production>`.
Known-good before the first Buildkite deploy (Oct 26 2026, same code as main 4e88630f):
staging `6dea1061-93f0-41eb-8350-c8bc8c5363af`, production `36ce4202-ebc8-4b69-9e0f-10979204d804`.
`workers_dev` / `preview_urls` are script-level settings, not part of a version, so a rollback leaves
them off.
