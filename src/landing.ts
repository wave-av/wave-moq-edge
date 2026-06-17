// moq.wave.online — WAVE MoQ Edge front-door.
// landingPage() must return the FULL chassis shell document (shell() call), NOT bare fragments.
// makeFetch(landingPage, ...) calls landingPage() and serves the result verbatim — if it gets
// bare HTML the chassis shell (nav, manifest, JSON-LD, theme-color) never renders.
import { shell } from '@wave-av/spoke-chassis';

export const LANDING_INNER = `<h1>wave <span class="acc">Media over QUIC</span></h1>
<p class="sub">Sub-second live media at the edge — IETF MoQ Transport (preferred draft-18, negotiation draft-07..draft-18) relay on Cloudflare Workers. Built by WAVE Online.</p>
<div><span class="tag">MoQ</span><span class="tag">WebTransport</span><span class="tag">QUIC</span><span class="tag">edge</span><span class="tag">sub-second</span></div>
<pre>  encoder / publisher
    │
    ▼   MoQ relay on the WAVE protocol plane
  POST <span class="acc">/v1/publish/:namespace/:track</span>
    │
    ├── WebTransport upgrade → live relay publisher session
    └── <span class="dim">fan-out to all subscribers via Durable Object</span>

  viewer / subscriber
    │
    ▼
  GET  <span class="acc">/v1/subscribe/:namespace/:track</span>
    │
    └── <span class="dim">WebTransport upgrade → relay subscriber session</span>
</pre>
<div class="row"><span class="k">publish track</span><span class="dim">POST <span class="acc">/v1/publish/:namespace/:track</span></span></div>
<div class="row"><span class="k">subscribe to track</span><span class="dim">GET <span class="acc">/v1/subscribe/:namespace/:track</span></span></div>
<div class="row"><span class="k">track metadata</span><span class="dim">GET <span class="acc">/v1/track/:namespace/:track</span></span></div>
<div class="row"><span class="k">active tracks</span><span class="dim">GET <span class="acc">/v1/announce</span></span></div>
<div class="row"><span class="k">MoQ catalog</span><span class="dim">GET <span class="acc">/v1/catalog</span></span></div>
<p class="sub" style="margin-top:1.4rem">Open source under MIT. Canonical source at
  <a href="https://github.com/wave-av/wave-moq-edge" rel="noopener">github.com/wave-av/wave-moq-edge</a>.
  Spec compliance reports and interop testing welcome.</p>`;

export function landingPage(): string {
  return shell({
    product: 'Media over QUIC',
    title: 'wave Media over QUIC — Sub-second live media at the edge',
    description: 'The WAVE MoQ relay — IETF draft-ietf-moq-transport-18 over WebTransport on Cloudflare Workers. Publish a track, fan out to thousands of subscribers in sub-second latency.',
    url: 'https://moq.wave.online',
    keywords: 'MoQ, media over QUIC, WebTransport, low latency, live streaming, IETF, WAVE',
    inner: LANDING_INNER,
    accentHex: '#00d4d5',
    ldHost: 'moq.wave.online',
    ldTagline: 'Sub-second live media at the edge via IETF MoQ Transport',
    cta: {
      primaryLabel: 'Open source on GitHub →',
      primaryHref: 'https://github.com/wave-av/wave-moq-edge',
      salesLabel: 'Talk to sales',
      salesHref: 'https://wave.online/enterprise',
      phrases: ['Publish a track', 'Subscribe globally', 'Sub-second latency', 'IETF draft-18', 'Durable Object fan-out'],
    },
  });
}
