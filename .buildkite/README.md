# wave-moq-edge on Buildkite (shadow mode)

This directory ports wave-moq-edge's credential-free GitHub Actions gates to Buildkite, using WAVE's
shared pipeline templates. Nothing under `.github/` changes. The GitHub workflows stay the gate until the
Buildkite pipeline has been green for 7 consecutive days. No Buildkite pipeline exists for this repository
yet; creating one is a separate operator step.

## Fork pull requests

This is a public repository, so anyone can open a pull request from a fork. **Fork pull requests are
refused by the pipeline setting `build_pull_request_forks: false`: Buildkite never starts a build for
them, so fork code never runs on these CI agents.** The tooling that creates the pipeline sets that value
and verifies it on the live pipeline. No step in this directory receives a secret either (see
"Credentials").

## Layout

| path | role |
|---|---|
| `pipeline.yml`, `wave-ci.sh` | The template kit's thin uploader and fixed shim, byte-identical to the kit at the pinned commit. Do not edit. |
| `wave-ci.json` | The settings the uploader renders: template `custom`, the kit pinned to commit 296cc0cf4faf1f06d0acd4c2a767d6c111d2adf3, 3 steps, 1 schedule. |
| `wave-ci.deferred.json` | NOT rendered. Every GitHub job with no running step yet, with the reason and the blocker (`parked_jobs`). |
| `scripts/<step>.sh` | One script per Buildkite step. Each checks its tools, runs its gates and prints a summary. |
| `scripts/lib/common.sh` | Strict mode, credential hygiene, the gate runner and the summary. |
| `gates/*.gate` | The VERBATIM `run:` bodies of the GitHub steps being replaced, named `<workflow>.<job>.<nn>-<step>.gate`. |

## Why the gates are copies

A gate that runs the same bytes as the GitHub step is a parity claim anyone can check. Each file header
names the workflow, job and step it came from and the commit it was copied at (4e88630f0b0f). The runner
executes it as `bash -e <file>`, GitHub's default shell, in the step's `working-directory` (`#
gh-working-directory:`) with the step's literal `env:` (`# gh-env: NAME=value`). To refresh one, copy the
step's `run:` body from the workflow unchanged. A failing gate does not stop the others in its step: every
gate runs, then the summary fails the step if any blocking gate failed.

## Parity: every GitHub Actions job

| GH workflow / job | triggers | Buildkite | notes |
|---|---|---|---|
| `_checks.yml` / `checks` | called by foundation-gate | step `foundation-gate` | secret scan + line-count check (max 800) |
| `_checks.yml` / `skill-validate` | called by foundation-gate | step `foundation-gate` | Python 3.12 + PyYAML, as on GitHub |
| `_checks.yml` / `verify-routes` | called by foundation-gate | step `foundation-gate` | URL convention check on `wrangler.toml` |
| `foundation-gate.yml` / `gate` | PR, push main/master/staging, merge_group | step `foundation-gate` | the caller of the three jobs above |
| `public-repo-guard.yml` / `guard` | PR, push main/master, merge_group | step `public-repo-guard` | gitleaks 8.30.1, content policy, body-policy fixtures |
| `moq-draft-drift.yml` / `drift` | PR (paths), push main, weekly cron | step `moq-draft-drift` + schedule `moq-draft-drift-weekly` | PR path filter mirrors `on.pull_request.paths` |
| `lint.yml` / `lint` | PR, push main | parked | private npm packages |
| `test.yml` / `test` | PR, push (paths) | parked | private npm packages |
| `bundle-eval-gate.yml` / `bundle-eval` | PR, push (paths) | parked | private npm packages |
| `governance-enforce.yml` / `enforce` | PR, push, merge_group | parked | private npm packages |
| `chassis-gate.yml` / `chassis` | PR, push main | parked | private reusable workflow; never runs on a public repo |
| `deploy.yml` / `deploy` | push, workflow_dispatch | parked | deploy: out of scope for this port |
| `gam-post-deploy-guard.yml` / `canary-guard` | workflow_run of deploy | parked | part of the deploy path |
| `auto-approve.yml` / `evaluate` | PR label events | parked | GitHub event bot |
| `issue-ops-triage.yml` / `triage` | issues | parked | GitHub event bot |
| `pr-agent.yml` / `pr_agent` | PR, issue_comment | parked | GitHub event bot |
| `public-repo-guard.yml` / `body-guard` | PR, issues, issue_comment | parked | GitHub event bot (scans PR/issue/comment text) |

17 jobs: 6 ported into 3 steps (plus the weekly schedule), 11 parked. Nothing is dropped.

## Schedule

`moq-draft-drift.yml` runs weekly (`0 6 * * 1`, Mondays 06:00 UTC). The settings declare it under
`schedules` as `moq-draft-drift-weekly`; a scheduled build runs only the `moq-draft-drift` step. The
Buildkite schedule itself is created from that list once the pipeline exists; this change creates nothing.

## Parked jobs

Each is listed in `wave-ci.deferred.json` with its reason and blocker. The GitHub workflow stays the gate
for these meanwhile.

- **Private npm packages** (`lint`, `test`, `bundle-eval`, `enforce`). Each one installs private
  `@wave-av/*` packages (`spoke-chassis`, `content-hash`, `governance`) from GitHub Packages, which the
  Buildkite agents cannot read from (HTTP 403). They will come from WAVE's self-hosted npm registry, which
  is in progress. No workaround is used here. When it lands, these become steps; each will then need a
  registry read credential.
- **Private code** (`chassis`). The check lives in a private repository's reusable workflow and composite
  action. GitHub cannot run it from a public repository, so it fails on every PR today; copying it here
  would publish private code.
- **Deploy** (`deploy`, `canary-guard`). Deploy and publish jobs are out of scope for this port.
- **GitHub event bots** (`evaluate`, `triage`, `pr_agent`, `body-guard`). They react to GitHub events
  Buildkite does not receive (labels, issues, comments, body edits) or write back to GitHub. They wait for
  a GitHub-event bridge, which is in progress.

## Differences from GitHub, on purpose

- Tools come from the CI image, never from a download in the job: gitleaks 8.30.1 (the version GitHub
  pins; the step fails if the image has another), ripgrep with PCRE2, Python 3.12 and PyYAML. The GitHub
  install steps (gitleaks download, `apt-get install ripgrep`, `pip install pyyaml`) are therefore not
  copied. If the selected Python lacks PyYAML, the step installs it into a job-local venv from PyPI.
- `GUARD_PRIVATE_REPOS` is a GitHub organization variable, and Buildkite cannot read it. Without it,
  `content-policy.sh` skips its private-name rule, exactly as it does on a developer machine; the step
  prints a warning. Every other content-policy rule runs.
- `merge_group` has no Buildkite counterpart; merge-queue builds would be ordinary branch builds.
- Path filters: on a PR, `moq-draft-drift` runs only when a file matching its GitHub `pull_request.paths`
  changed. A main build runs every step, as GitHub's unfiltered `push` trigger does. Any change under
  `.buildkite/` runs every step.
- `harden-runner` steps are specific to GitHub's runners and are not copied; checkouts are the agent's.

## Credentials

No running step declares or receives a secret. `scripts/lib/common.sh` unsets every credential-shaped
name before any gate runs.

## Checking a change locally

With a checkout of the template kit at the pinned commit (and `npm ci` in its `tools/caps-lint`):

```sh
node <kit>/bin/wave-ci-render.mjs --settings .buildkite/wave-ci.json --context <ctx.json> --out-dir <empty dir>
node <kit>/bin/wave-ci-render.mjs --settings .buildkite/wave-ci.json --schedules
node <kit>/tools/caps-lint/bin/caps-lint.mjs <empty dir>/*.yml .buildkite
```

The step scripts refuse to run outside a Buildkite job (`BUILDKITE=true`).
