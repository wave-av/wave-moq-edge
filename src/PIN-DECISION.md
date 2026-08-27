# E1-TAI-BRIDGE wire-revision pin — decided on purpose, not by drift

_Decided 2026-08-21, phase E1-TAI-BRIDGE of the `volumetric-delivery-proof` epic._

## What is pinned, and to what

Two DIFFERENT things are versioned in this repository, and this phase pins only one of them:

1. **The relay's negotiated ALPN** (`MOQ_ALPN = 'moqt-18'`, `wrangler.toml MOQ_DRAFT_VERSION = "18"`,
   guarded by `scripts/check-moq-draft-version.sh`) — this is the wire the relay actually SPEAKS on
   the network, negotiated per-connection. Bumping it is a relay-wide change (transport framing,
   SETUP negotiation, every connected client) and is explicitly **out of scope** for this phase.
   `check-moq-draft-version.sh` already tracks it, is already stale by one revision (18 vs the
   published 19), and that staleness is real but belongs to whichever phase re-negotiates the ALPN —
   not to this one.

2. **The Object Properties semantics this mapping's property bag is written against** — i.e. which
   revision's TEXT governs what a relay is required to do with `MoqObject.properties` /
   `SubgroupObject` + the PROPERTIES flag. **This phase pins that to draft-ietf-moq-transport-19.**

## Why draft-19, while the relay still negotiates draft-18 on the wire

draft-18's SUBGROUP_HEADER already reserves the PROPERTIES flag (0x01) and a length-prefixed
per-object property block — `moq-wire.ts:skipObjectProperties` already walks it, and
`viewport-properties.ts` (merged before this phase) already made the same call for the same reason:
draft-19 §2.5 is the revision that states, in words, what a relay MUST do with a Property it does not
understand — *"If a Relay does not support a Property, it MUST NOT be modified, MUST be forwarded,
and MUST be cached with the Track or Object"* — and -19's release notes recommend Immutable
Properties precisely for relay-visible unmodifiable data like a capture timestamp. draft-18 reserves
the SLOT; draft-19 is the revision that SPECIFIES the behavior this mapping's property bag depends on
(a relay forwarding+caching a bag it cannot parse). Writing the codec against -19's semantics while
the ALPN still negotiates `moqt-18` is safe and additive: the wire bytes are identical (a
length-prefixed opaque block either draft is happy to carry), only the SPECIFICATION TEXT this
module's behavioral claims are grounded in differs.

## The drift gate

`scripts/check-tai-mapping-draft-pin.sh` prints the PINNED revision (19, this file) and a
LIVE-KNOWN revision (also 19, last manually verified 2026-07-06 per the epic's grounding note — see
`governance/plans/volumetric-delivery-proof/E1-TAI-BRIDGE.md`) as two SEPARATE values, and fails in
`--ci` mode if they disagree. **This build phase runs under a no-external-contact rule** (internal,
local-only build — see the phase brief), so the LIVE-KNOWN value is NOT fetched over the network by
the script; it is a manually-maintained constant, exactly like `check-moq-draft-version.sh`'s own
`CURRENT_DRAFT_NUM` (which is also a hand-maintained constant, not a live fetch — that script's own
header says "Source of truth: wrangler.toml", the CURRENT_DRAFT_NUM comparison value is itself
manually kept up to date by whoever last checked the datatracker). The honest gap: a real network
check against `https://datatracker.ietf.org/doc/draft-ietf-moq-transport/` has NOT been run by this
script in this session; the 19 is carried forward from the epic's grounding note dated 2026-08-22,
which itself states it was measured that day. Re-verify and update `LIVE_KNOWN_DRAFT` here and in the
script the next time this phase (or a successor) is touched with network access.
