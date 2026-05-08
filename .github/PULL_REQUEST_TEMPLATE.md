<!--
Thanks for the PR. Please confirm before submitting:

1. You opened an issue first for non-trivial changes (not required for bug fixes)
2. The change is in scope per CONTRIBUTING.md (transport-only, MoQ-spec-aligned)
3. Tests cover the change OR you've explained why they don't
4. Commit is signed off (`git commit -s`) per the DCO

If this is a security fix, please email security@wave.online instead of opening
a public PR.
-->

## What this PR does

<!-- One or two sentences. -->

## Why

<!-- Reference the issue number(s). -->

Closes #

## Scope confirmation

- [ ] Transport-only (does not encode video, adapt bitrate, authenticate users, or record analytics)
- [ ] MoQ-spec-aligned (cite section/paragraph if relevant)
- [ ] Cloudflare Workers runtime (does not target node/deno/bun)

## Verification

- [ ] `pnpm tsc --noEmit` passes
- [ ] `pnpm wrangler deploy --dry-run` passes
- [ ] New tests under `__tests__/` cover the change (if applicable)
- [ ] Interop tested against at least one reference client (specify which)

## Spec compliance impact

<!--
If this changes wire-protocol behavior, note which draft revision it aligns with
and whether it's backward-compatible with prior drafts.
-->

## Checklist

- [ ] Commit signed off (`git commit -s`)
- [ ] No new dependencies (or new dep is pinned + audited)
- [ ] No breaking changes to public API (or version bump notes included)
