# `wave-demo/1` frame envelope (examples only)

The three files in `examples/` interoperate by putting a tiny, self-describing header in front of
every MoQ object payload. **This envelope is not part of IETF MoQ Transport** and the relay never
looks at it — to the relay an object payload is opaque bytes. It exists so that the zero-dependency
browser subscriber can tell "raw RGBA test pattern" from "H.264 access unit", and so that latency can
be measured end to end without a side channel.

A real deployment carries a real catalog (`GET /v1/catalog`, draft-ietf-moq-catalogformat-01) and a
real codec bitstream, and needs none of this.

## Layout (16-byte header, little-endian)

| offset | size | field                                                             |
| ------ | ---- | ----------------------------------------------------------------- |
| 0      | 1    | magic `0x57` (`'W'`)                                               |
| 1      | 1    | version = `1`                                                      |
| 2      | 1    | kind: `1` = RGBA8888 raw frame, `2` = H.264 Annex-B access unit    |
| 3      | 1    | flags: bit 0 = keyframe / IDR                                      |
| 4      | 8    | capture time, float64 epoch milliseconds (`Date.now()`)            |
| 12     | 2    | width (uint16), `0` when unknown (H.264 — read it from the SPS)    |
| 14     | 2    | height (uint16), `0` when unknown                                  |
| 16     | …    | media bytes: `width*height*4` RGBA bytes, or one Annex-B AU        |

## Latency

`latency = receive_time − capture_time`, so the number on screen includes encode/publish, the relay
hop, and the browser's receive path. It is only meaningful when the publisher's and the subscriber's
clocks agree — true by construction when `interop-test.sh` runs both on one machine, and roughly true
across NTP-synced hosts. Both the browser UI and the interop script say so.

## Grouping

One MoQ Group per keyframe (the natural random-access point), one Object per frame within the group.
That is what makes the relay's `MOQ_CACHED_GROUPS` late-joiner cache useful: a subscriber that
arrives mid-stream is handed the recent groups and can start decoding from a group boundary.
