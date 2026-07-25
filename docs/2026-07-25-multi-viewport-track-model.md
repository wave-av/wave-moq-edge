# The Multi-Viewport Track Model over MoQ

_Date: 2026-07-25 · Issue: wave-moq-edge#118 · Status of this document: **design + hermetic
implementation**. Nothing here is proven live._

## North Star (this node)

**A source producing up to 16 concurrent virtual camera viewports — MVP commit 8×1080p60 + 2×2160p60 —
plus per-viewport pose and metadata, delivered over MoQ as 16 independent Tracks and one low-rate
canvas track, with the PTP media timeline mapped onto MoQ Group and Object IDs and the exact capture
instant carried as an Object Property.**

This node owns the track shapes for the whole programme. The relay's runtime priority/timeout
enforcement, the compositor that renders the canvas mosaic, and the end-to-end demo are separate.

## 0. Why this document exists

MoQ Transport is deliberately media-agnostic, and the streaming-format layer above it (MSF, CMSF, LOC)
maps CMAF and low-overhead audio/video. Neither layer says anything about multi-view, viewport-dependent
delivery, or volumetric media: a survey of the MoQ Internet-Drafts finds **no draft addressing 3D,
volumetric, point-cloud, multi-view or tiled delivery**, and the IETF 126 MoQ minutes contain zero
mentions of them. The mapping is unclaimed.

It is also unclaimed at the *timing* seam. **MoQ draft-18 carries no timestamps at all** — the object
model is Object / Subgroup / Group / Track and none of the four has a time field. Professional sources
are PTP-locked to SMPTE ST 2059-2 at sub-microsecond accuracy. How a PTP media timeline becomes MoQ
Group and Object IDs is undefined, and getting it wrong is not cosmetic: it decides whether 16 viewports
can be spliced against each other at all.

This document states WAVE's answer, with the arithmetic, the alternatives we rejected, and the open
questions. WAVE's contribution here is a **streaming-format mapping and a running implementation** — not
a transport change, not a codec, and not a claim on anyone else's layer.

## 1. Status ladder — designed / implemented / proven

Read this table before quoting anything below.

| Element | Designed | Implemented | Proven |
|---|---|---|---|
| Track topology (16 + canvas) | ✅ | ✅ `src/viewport-tracks.ts` | **G3.5 PROVEN HERMETIC** |
| Catalog with real `selectionParams` | ✅ | ✅ `src/viewport-catalog.ts` | **G3.5 PROVEN HERMETIC** |
| PTP → Group/Object mapping | ✅ | ✅ `src/viewport-model.ts` | **G3.5 PROVEN HERMETIC** |
| Object Properties codec (pose, capture instant) | ✅ | ✅ `src/viewport-properties.ts` | **G3.5 PROVEN HERMETIC** |
| Properties surviving the relay round trip | ✅ | ✅ `src/moq-wire.ts` (additive) | **G3.5 PROVEN HERMETIC** |
| Priority + delivery-timeout **policy values** | ✅ | ✅ (as data) | **G3.5 PROVEN HERMETIC** (the table; not its effect) |
| Relay *enforcing* priority / shedding on timeout | ✅ | ❌ | ❌ — separate issue |
| Canvas mosaic *composition* (who encodes it) | ❌ open question | ❌ | ❌ — separate issue |
| Catalog served from live track enumeration | ✅ | ❌ | ❌ — hard-blocked, see §9 |
| Interop against a third-party relay | ✅ | ❌ | ❌ — blocked on draft-19 + native WebTransport |

**G3.5 PROVEN HERMETIC** means: proven in-process against the real relay core (`MoqRelay` →
`MoqTrackSet` → `ViewportTrackSet`) with no network, no Durable Object and no socket —
`__tests__/viewport-track-model.test.ts`, 30 tests. It is **not** a live receipt and must never be
quoted as one. Nothing in this document is PROVEN LIVE.

## 2. The topology we chose

> **16 independent MoQ Tracks (one per viewport) + 1 low-rate canvas/proxy track. Pose, capture
> instant and viewport identity ride as Object Properties on the media objects. No metadata sidecar
> track. No subgroup packing. A client holds ~3 subscriptions, never 16.**

```
namespace ("wave", tenant, event)
├── catalog            ← MSF catalog track (17 tracks + the timing grid + the tile map)
├── canvas             ← 4x4 mosaic of all 16 viewports, 20 fps, 2.5 Mbps   [priority 0]
├── viewport-00        ← 2160p60, 40 Mbps, altGroup 1   ─┐
├── viewport-01        ← 2160p60, 40 Mbps, altGroup 2    │  each an INDEPENDENT Track:
├── viewport-02..09    ← 1080p60, 10 Mbps each           │  own subscribe, own priority,
└── viewport-10..15    ← declared, not yet active       ─┘  own cancel, own delivery timeout
```

Each object on a viewport track carries, as Object Properties: `VIEWPORT_ID`, `CAPTURE_TAI_NS`,
`CLOCK_STATE`, `POSE`, optionally `INTRINSICS`, and `RIG_ID`.

### 2.1 Why one Track per viewport, not one Subgroup per viewport

A Subgroup is pinned to a single stream and may not be split (draft-18 §11 `subgroup-header`;
draft-19 §2.2). Packing 16 viewports into subgroups of one Track would surrender, in one move:

- **independent subscription** — a subscriber takes the Track or nothing, so "give me viewport 7" is
  inexpressible and every client carries all 160 Mbps;
- **independent priority** — Subscriber Priority is per-subscription, so the viewport the user is
  looking at cannot outrank the fifteen they are not;
- **independent cancellation** — dropping one viewport means dropping the Track;
- **independent delivery timeout** — one timeout for the hero camera and the idle ones together,
  which destroys the shedding policy in §5.

Every knob the congestion policy needs is a per-Track knob. That settles it.

### 2.2 Why a canvas track — the arithmetic

Declared contribution rates for the MVP rig:

| | count | each | subtotal |
|---|---|---|---|
| 2160p60 viewports | 2 | 40 Mbps | 80 Mbps |
| 1080p60 viewports | 8 | 10 Mbps | 80 Mbps |
| **rig aggregate** | **10 active** | | **160 Mbps** |
| canvas (1920×1080, 20 fps, 4×4 tiles of 480×270) | 1 | 2.5 Mbps | 2.5 Mbps |

- Canvas as a fraction of the rig: **2.5 / 160 = 1.5625%**.
- Survey cost reduction: **160 / 2.5 = 64×**. One track shows all 16 viewports for 1/64th of the
  bitrate of subscribing to all of them.
- Survey-then-solo client load: canvas + one 2160p60 hero + one 1080p60 secondary =
  **2.5 + 40 + 10 = 52.5 Mbps**, against **162.5 Mbps** for naive all-16-plus-canvas → **3.10×** less.
- Subscriptions held: **3**, not 17.

That last number is the one that matters most, and it is not a taste preference. Published many-track
MoQ measurement finds aggregate throughput **peaking at N = 5 tracks** — not 10, not 25 — with tracks
desynchronising at the relay beyond that (arXiv:2412.07889). A client holding 17 subscriptions is
asking for exactly the failure the canvas exists to prevent. **16-way fan-out is a RELAY property, not
a CLIENT property.** That is the whole trick.

### 2.3 Relay fan-out cost

Ingest is 17 tracks either way — that is the relay's job. Egress is where the topology pays:

| at S = 100 subscribers | forwarding contexts | egress |
|---|---|---|
| naive: every client subscribes to all 17 | 100 × 17 = **1,700** | 100 × 162.5 Mbps = **16.25 Gbps** |
| survey-then-solo: canvas + hero + secondary | 100 × 3 = **300** | 100 × 52.5 Mbps = **5.25 Gbps** |

**5.7× fewer forwarding contexts, 3.1× less egress**, and every subscriber stays under the measured
many-track ceiling.

### 2.4 Client join time

| step | cost |
|---|---|
| fetch catalog | 1 RTT |
| SUBSCRIBE `canvas` | 1 RTT |
| first decodable canvas frame | **~0 additional** — the relay replays its cached recent groups on SUBSCRIBE, starting at a group boundary |
| without the late-joiner cache | E[½ group] = **125 ms**, worst case **250 ms** |
| viewport switch (SUBSCRIBE a new viewport track) | 1 RTT + cache replay from a group boundary |

The 250 ms group is chosen against this: shorter groups make a switch land faster and cost more
keyframes. 250 ms is 15 frames at 60p, and it divides the TAI second exactly.

Proven hermetically: the switch test asserts the replay's first object is `objectId = 0` — a group
boundary — so the switch costs a cache replay, not a group of latency.

### 2.5 Object sizing

A 2160p60 frame at JPEG XS 4 bpp is 3840 × 2160 × 4 / 8 = **4,147,200 B**, comfortably under the
deployed 16 MiB message ceiling. At 40 Mbps long-GOP the average object is 40e6 / 60 / 8 = **83,333 B**;
a 1080p60 object at 10 Mbps is **20,833 B**. Frame-granular objects are fine at every rung.

## 3. Catalog design

`src/viewport-catalog.ts` builds on the existing `src/catalog.ts` MSF skeleton — same `version`,
`streamingFormat`, `commonTrackFields`, `tracks`, same `loc` packaging — and adds exactly two things.

**1. Real `selectionParams`.** `catalog.ts` today emits a clearly-labelled `FIXTURE_` because the KV
registry stores only `{namespace, track, region, started_at}`. A rig descriptor carries the actual
encode per viewport, so every track here gets true `codec` / `width` / `height` / `framerate` /
`bitrate`. The test asserts the serialized catalog contains no `FIXTURE` string at all.

**2. Two vendor-prefixed extension blocks**, for the three things MSF has no field for:

- per-track `wave-viewport`: `{ id, role, rigId, pose, intrinsics, canvasTile, active, objectsPerGroup }`
- root `wave-rig`: the **timing grid** (timescale, rational grid rate, frames per group, group duration,
  epoch, and the mapping formula written out in full so no implementer has to guess it), the **canvas
  tile map** (row-major `tileOrder`), and `recommendedMaxConcurrentSubscriptions`.

An MSF parser that ignores unknown keys still reads a valid catalog listing 17 ordinary video tracks.

**Grouping semantics.** `renderGroup` is uniform across the rig — canvas and viewports are meant to be
presented together. `altGroup` is **distinct per viewport**, because a viewport's renditions are
alternates of *each other* and a different camera is not an alternate of anything. So a 3-rung ladder
over 16 viewports is 48 media tracks in 16 switching sets, per the CMSF rule, and each rung stays
independently subscribable, prioritisable and cancellable.

**Dynamism.** `supportsDeltaUpdates: true`. A 16-viewport rig is inherently dynamic — virtual cameras
are spawned and retired mid-show — and MSF's `add | remove | clone | update` is how viewport 13 spawns
inheriting viewport 1's parameters. The catalog lists all 16 declared slots with `active: false` for
the ones not yet producing, so a client's tile map is stable across activation.

**Discovery order.** Canvas is track index 0. A client reading top-down can issue its first SUBSCRIBE
before it has finished parsing.

## 4. The timing seam: PTP ↔ MoQ

### 4.1 The mapping

Every track of a rig shares one **grid rate** `R` (a rational — 60/1, or 60000/1001) and one **group
size** `G` in grid slots. For a capture instant `t` in TAI nanoseconds since the PTP epoch:

```
F     = round(t_TAI_ns · R_num / (R_den · 1e9))      // grid frame index
Group = floor(F / G)
Object= F mod G
```

and the **exact** capture instant travels alongside as the `CAPTURE_TAI_NS` Object Property.

That split is the design:

- **Group/Object give alignment and ordering.** Derived, stateless, requiring zero coordination.
- **The Object Property gives the timestamp.** Exact to the nanosecond, relay-forwarded verbatim.

**The load-bearing consequence:** two encoders that have never exchanged a byte, both PTP-locked, both
told the same `(R, G)`, emit **identical Group IDs for the same instant**. Group boundaries align
across all 16 viewports for free — no coordination protocol, no epoch negotiation, no SETUP option. A
viewport switch therefore lands on a boundary that is common to both tracks, and a subscriber can
splice without a resync heuristic. It also survives a relay restart, a late joiner and a FETCH, none of
which carry session state.

At the MVP grid (`R = 60/1`, `G = 15`): groups are exactly **250 ms**, and `Group = floor(t_TAI_ns / 250e6)`.

### 4.2 ROUND, not FLOOR — and why that is not a detail

A grid slot boundary sits at a **non-integer nanosecond** for every rate that does not divide 1e9, and
60/1 is already one of them: 1e9/60 = 16,666,666.**67** ns. PTP timestamps are integers of nanoseconds,
so the instant nominally at slot 2 quantizes to 33,333,333 ns — **0.33 ns below** the true boundary.
`floor` files it in slot 1. One third of a nanosecond of quantization becomes a whole-frame error, on
every third frame, forever.

`round` files a timestamp within ±half a slot (**±8.33 ms** at 60p) into the slot it was captured for.
Genlock jitter is sub-microsecond, so that is **four orders of magnitude** of margin.

This was caught by the hermetic test, not by reasoning. It is now asserted directly: the test shows the
floor form yields slot 1 and the round form yields slot 2 for the same real timestamp.

### 4.3 Derive from the frame index, not from wall-clock group duration

The tempting shortcut is `Group = floor(t / T_GROUP)` with `T_GROUP` held as a nanosecond constant. For
Group ID alone that is algebraically identical **under exact rational arithmetic** — but no
implementation does exact rational arithmetic on a constant. At 60000/1001 the frame duration is
16,683,333.333… ns; materialize it as `16_683_333` and you accrue **1/3 ns per frame**, slipping a
whole frame after ~5.0 × 10⁷ frames ≈ **9.7 days** of continuous run. That is the length of a venue
installation, not of a lab session. The frame-index form divides once, from the timestamp, and is exact
for every rational rate and every run length.

### 4.4 One grid for mixed rates

A 20 fps canvas and a 60 fps viewport have different native frame indices. Deriving **every** track
from the shared grid fixes it: the 20 fps canvas emits one object every 3 grid slots, so its Object IDs
are sparse (0, 3, 6, 9, 12) and its **group boundaries coincide exactly** with the 60 fps tracks'.

The constraint this imposes is real and is **enforced, not assumed**: a track rate must divide the grid
into a whole number of objects per group. On a 60/1 grid with 15-slot groups, a 15 fps track would need
3.75 objects/group and is **rejected** by `objectsPerGroup()`. Pick 20 fps, or change the group size.
This is why the canvas in this design is 20 fps and not the more obvious 15.

### 4.5 Group ID width — the cost of statelessness

At 250 ms groups, a 2026 instant gives Group ≈ 7.14 × 10⁹ < 2³³, needing a **5-byte** draft-18 varint
(7 value bits per byte). A session-relative ID over a 4-hour show peaks at 4·3600/0.25 = 57,600 < 2¹⁷ →
**3 bytes**. The absolute form costs **2 extra bytes per object**:

```
16 tracks × 60 fps × 2 B = 1,920 B/s   against   160 Mbps = 20,000,000 B/s
                                       = 9.6e-5 of the wire = 0.0096%
```

Paid deliberately. A session-relative ID needs an epoch that a relay must hold and a late joiner must
fetch — and that epoch is precisely the state this design exists to avoid. `groupEpochTaiNs` remains
the escape hatch for implementations that need small IDs; `0` (the default) means absolute TAI.

## 5. Priority and delivery order

Subscriber Priority is one byte and **lower value = higher priority** (draft-18 §7). The scheduler
picks lowest Subscriber Priority, then lowest Publisher Priority, then longest-waiting stream. Priority
is keyed on **what the subscriber is doing with the track**, not on what the track is:

| intent | Subscriber Priority | `SUBGROUP_DELIVERY_TIMEOUT` |
|---|---|---|
| canvas | **0** | 500 ms |
| audio | 8 | 250 ms |
| **hero** (on screen) | 16 | 100 ms |
| secondary (PiP / confidence) | 32 | 100 ms |
| prewarm (subscribed, not displayed) | 128 | 33 ms |

**The brief's requirement — "a viewport the user is looking at must beat one they are not" — is
`hero(16) < prewarm(128)`,** asserted in the test.

**Canvas is deliberately the highest-priority video on the session**, above the hero. It is the
navigation surface: lose it and the operator cannot even find the viewport they want to switch to. It
is 1.5625% of the rig's bitrate, so protecting it is nearly free.

**The delivery timeout is the adaptation mechanism, not a bitrate ladder.** Under congestion the relay
drops a stale subgroup rather than buffering it, so the link degrades by shedding the tail instead of
by growing latency. Published point-cloud-over-MoQ work finds the timeout knob is where the adaptation
actually lives (raising 50 ms → 500 ms at 300 Mbps changed delivered throughput by +27.9% to +360.2%,
arXiv:2507.15673). The values above are keyed to the 250 ms group: prewarm at 33 ms cannot survive two
frame times of queueing and sheds first, by design; hero gets 100 ms (~6 frames of 60p) so a brief
congestion event does not visibly stall the on-screen viewport; canvas gets 500 ms — two full groups —
because a late canvas frame is still useful for navigation and losing it is worse than showing it late.

**Publisher Priority** stays with the publisher (relays MUST NOT modify it) and is used *within* a
track to rank a keyframe subgroup above delta subgroups.

⚠️ **These values are designed and implemented as data, and the ordering is proven hermetically. The
relay does not yet ENFORCE them.** Enforcement is a separate issue and no claim is made here.

## 6. Where pose lives — and the sidecar track we rejected

Pose, intrinsics, viewport identity, capture instant and clock state ride as **Object Properties on the
same object as the frame**.

draft-19 §2.5 is explicit: *"If a Relay does not support a Property, it MUST NOT be modified, MUST be
forwarded, and MUST be cached with the Track or Object"*, and -19 recommends Immutable Properties
precisely for relay-visible unmodifiable data. draft-18 — what we run today — already reserves the
`SUBGROUP_HEADER` PROPERTIES flag (0x01) and a length-prefixed per-object property block that
`moq-wire.ts:skipObjectProperties` already walks. **So the block is expressible on the wire we actually
run.**

Codepoints are **provisional private use, 0xFF00–0xFF0F**, deliberately *outside* draft-19's mandatory
0x4000–0x7FFF range. An endpoint receiving an unsupported *mandatory* property "MUST NOT process or
forward that track" — so putting viewport metadata there would mean a relay that has never heard of a
viewport drops the video. Fail-open on metadata is the right trade; dropping media because a relay did
not understand a pose field is not. These codepoints MUST be replaced by IANA-registered values before
any interop claim.

**Pose precision.** `POSE` is 7 × float32 = 28 B/object (position xyz + quaternion xyzw). Float32 gives
~1e-7 relative error: at a 100 m venue radius that is **~6 µm** of position error, three orders below
any camera-pose requirement, for half the bytes of float64. This is a deliberate size/precision trade
and the test asserts the *bound*, not equality.

### Alternatives rejected

| Alternative | Why rejected |
|---|---|
| **A. 16 viewports as subgroups of one Track** | §2.1 — surrenders independent subscribe, priority, cancel and delivery timeout. |
| **B. One muxed track, viewports interleaved by Object ID** | A client must receive all 160 Mbps to watch one viewport. Defeats the entire point. |
| **C. A parallel pose/metadata sidecar track** | A sidecar has its OWN subscription, OWN delivery timeout and OWN scheduling slot, so pose and frame decouple exactly when the network is worst — and it adds a track to a topology already bounded by the N≈5 desync measurement. Riding the object means pose cannot arrive without its frame, by construction. |
| **D. Pose inside the LOC container payload** | Invisible to relays: no relay-side filtering, no property-based priority, and a subscriber must parse the payload to know which camera it is looking at. Kept as an option for *bulky* per-frame data; rejected for identity and timing. |
| **E. Session-relative Group IDs with an epoch in the catalog** | §4.5 — the epoch is state a relay must hold and a late joiner must fetch, for a 0.0096% saving. |
| **F. `Group = floor(t / T_GROUP)` from a nanosecond constant** | §4.3 — slips a whole frame after ~9.7 days at 59.94. |
| **G. UTC-derived timestamps** | §7.1 — a leap second replays a second of frame indices. Rejected by assertion, not by convention. |

## 7. Failure modes of the mapping

1. **UTC instead of TAI.** A leap second in a UTC-derived clock replays one second of frame indices →
   duplicate Group/Object IDs, which MoQ reads as retransmission. TAI has no leap seconds. The catalog
   MUST declare `timescale: "TAI"` and a non-TAI grid **throws**.
2. **Grandmaster steps backwards.** Group IDs would regress; MoQ expects them non-decreasing.
   `ClockGuard` clamps to `lastFrame + 1` and flags `CLOCK_STATE = DISCONTINUITY` on that object. The
   object is still emitted — we degrade the timing claim, not the media.
3. **Grandmaster steps forwards.** Leaves a Group ID **gap**. Benign — MoQ tolerates gaps — but a jump
   larger than one group is still flagged DISCONTINUITY so a subscriber does not read it as loss.
4. **Rate heterogeneity.** §4.4. Enforced by `objectsPerGroup()`, which throws rather than rounding.
5. **PTP lost → free-run.** The mapping silently becomes a fiction. `CLOCK_STATE` carries
   LOCKED / HOLDOVER / FREERUN so a subscriber can *tell*, rather than trusting a number.
6. **Group ID width.** §4.5 — quantified, and accepted.
7. **A relay that rewrites Group IDs.** draft-19 removed the relay exception for reordering or dropping
   objects; a draft-18 relay has more latitude. Our own relay re-stamps only the Track Alias and leaves
   Group/Object untouched — asserted in the test — but a third-party -18 relay is an untested risk.
8. **Sub-frame capture skew across viewports.** Two viewports genlocked to the same grandmaster land in
   the same slot but not at the same nanosecond. `CAPTURE_TAI_NS` preserves the true skew; the slot
   deliberately does not.

## 8. draft-19 relevance (we run -18 today)

We run draft-18 in production (`MOQ_ALPN = 'moqt-18'`); -19 was published 2026-07-06. ALPN is the
version negotiation, so `moqt-18` will not negotiate with a `moqt-19` peer — that gap is tracked
separately (wave-moq-edge#114) and is **not** closed by this work.

-19 adds three things this model wants, and the design is shaped so that adopting them is an upgrade,
not a redesign:

| -19 primitive | What it gives this model | What we do on -18 today |
|---|---|---|
| **Properties** (Track/Object, Mandatory/Immutable) + the §2.5 relay rule | A first-class, relay-cacheable home for `wave-viewport-pose` | -18's existing per-object property block, carried verbatim through the relay; provisional codepoints |
| **`SUBSCRIBE_TRACKS`** + Track Property filters | "Every track in this namespace where `role = follow`" — an agent-addressable viewport query with no bespoke API | Read the catalog: same fields, one extra round trip |
| **Range Filters** | Server-side object filtering per subscription | Not available; the client filters |

Two -19 items we are watching rather than designing against: **Sender-Side Track Switching** (a viewport
switch ideally rides SWITCH rather than SUBSCRIBE+UNSUBSCRIBE, which leaves queued groups in flight),
whose WG disposition is contested and unresolved; and **delivery timeouts as both Track and Object
Properties**, which would let a single object opt out of shedding.

## 9. What is NOT done

- **The catalog is not yet served from live track enumeration.** `GET /v1/catalog` returns
  `"tracks": []` today while `/metrics` reports active tracks — the enumeration fix is a **hard
  dependency** for serving this catalog from the live relay, and it is a separate issue.
- **The relay does not enforce the priority/timeout table.** It is data here, not behaviour.
- **Nobody composes the canvas mosaic.** Who encodes it — the source rig, an edge compositor, or a GPU
  worker — is an **open question**, not an assumption. This document defines the canvas track's
  *shape*, not its producer.
- **No live receipt, no interop receipt.** Interop is blocked on both the -19 ALPN bump and a native
  WebTransport/QUIC binding (our transport is a WebSocket envelope today).
- **The provisional property codepoints are not registered.**

## 10. Open questions

1. **Who owns viewport identity — the catalog, an Object Property, or the LOC container header?** We
   put it in both catalog and property, deliberately redundantly. Picking wrong forces a redesign after
   WG feedback.
2. **Is 250 ms the right group?** It divides the TAI second and bounds switch latency, but a tighter
   end-to-end budget may not tolerate group boundaries at all — in which case the volumetric path needs
   datagram forwarding preference end-to-end and this whole mapping needs a datagram form.
3. **What is the practical concurrent-subscription ceiling on a production third-party relay?** The
   N=5 result is from an event-vision workload, not 1080p60 viewports. Our `4` is a conservative read
   of someone else's measurement and should become our own.
4. **Does an existing individual draft cover immersive/tiled/viewport-dependent MoQ delivery** that
   this would collide with? A survey found none; absence of evidence is weak.
5. **Should the canvas be one track or an `altGroup` ladder of canvases** (e.g. 4×4 and 2×2)? A ladder
   costs another track against a topology already bounded by the desync ceiling.
6. **Does the grid rate belong in the catalog or in a SETUP option?** Catalog is stateless and works
   with FETCH; a SETUP option would let a relay validate it.

## 11. Where the code is

| File | What |
|---|---|
| `src/viewport-model.ts` | The PTP↔MoQ mapping, `ClockGuard`, viewport/rig descriptors, priority + timeout policy |
| `src/viewport-properties.ts` | Object Property codec (viewport id, capture instant, clock state, pose, intrinsics, rig id) |
| `src/viewport-catalog.ts` | The MSF catalog with real `selectionParams` + the `wave-viewport` / `wave-rig` blocks |
| `src/viewport-tracks.ts` | `ViewportTrackSet` — the rig bound to the existing `MoqTrackSet` → `MoqRelay` path |
| `src/moq-wire.ts` | One additive change: `MoqObject.properties`, carried verbatim so properties survive the relay's decode/re-encode. A properties-free object encodes byte-identically to before. |
| `__tests__/viewport-track-model.test.ts` | 30 hermetic tests — the G3.5 evidence for everything above |

## 12. Boundary — what WAVE does not claim here

- WAVE does **not** author moq-transport. We contribute a **streaming-format mapping and an
  implementation**, and should say exactly that.
- WAVE does **not** define splat or point-cloud **compression**. The payload codec is someone else's
  art. We define the track/catalog/property mapping — the envelope, not the contents.
- MoQ is **not** an RFC. The WG milestone is IESG submission in Dec 2026 and no WGLC has been called.
- WAVE does **not** run the latest draft. We run -18; -19 is current.
- Nothing in this document is **PROVEN LIVE**. See §1.
