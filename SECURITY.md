# Security policy — moq-edge

## Reporting vulnerabilities

Email [security@wave.online](mailto:security@wave.online).

- We respond within 48 hours
- We follow a 90-day coordinated disclosure timeline by default (faster if the vulnerability is being actively exploited)
- Do **not** file public GitHub issues for security findings

## Supported versions

We patch security issues on the latest minor version aligned with the current MoQ draft. Older draft alignments are EOL when the next draft ships.

| Version | MoQ draft (preferred) | Negotiation range | Status |
|---|---|---|---|
| 0.x | draft-18 | draft-07 .. draft-18 | Supported |
| (future) 1.x | draft-20+ | drops drafts < 12 | Will replace 0.x |

## Threat model

moq-edge is a publicly-reachable Cloudflare Worker that handles untrusted media payloads from publishers and serves them to untrusted subscribers. The threat model focuses on:

- **Resource exhaustion** — publishers spamming objects, subscribers spamming subscribes, malformed frames consuming CPU
- **Protocol-level injection** — malformed MoQ control messages causing crashes or unintended behavior in the Durable Object
- **Cross-tenant data leakage** — track namespaces from one customer reaching another's subscribers
- **Replay attacks** — publishers replaying recorded streams as live
- **Authentication bypass** — unauthorized publish/subscribe without WAVE-issued capability tokens

We **do not** treat as in-scope:

- Cloudflare platform-level vulnerabilities (report directly to Cloudflare)
- DDoS at the network level (Cloudflare's edge handles this)
- Vulnerabilities in user-supplied media codecs (out of scope — moq-edge is transport-only)

## Mitigations in place

- All HTTP routes parse input with [Zod](https://zod.dev) before dispatch
- Per-namespace and per-track rate limits in the Durable Object
- Object size cap via `MAX_OBJECT_SIZE_BYTES` env var
- Subscriber count cap via `MAX_SUBSCRIBERS_PER_TRACK` env var
- All inbound requests pass through the Cloudflare WAF before reaching the Worker
- Capability-token-based authentication for publish (TODO: subscribe — currently public for interop testing)

## Out-of-scope known issues

- The wire protocol implementation is currently a **scaffold** for interop framework testing. Full draft-18 compliance is on the roadmap (version negotiation is in place; message framing/object headers/FETCH/GROUP semantics ship in 0.2.x). Spec drift bugs in this period are tracked publicly and not treated as security issues unless they enable cross-tenant data leakage.

## Hall of fame

When researchers responsibly disclose, we list them here (with permission):

_(empty — be the first)_
