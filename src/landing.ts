// moq.wave.online — WAVE MoQ Edge front-door.
// landingPage() must return the FULL chassis shell document (shell() call), NOT bare fragments.
// makeFetch(landingPage, ...) calls landingPage() and serves the result verbatim — if it gets
// bare HTML the chassis shell (nav, manifest, JSON-LD, theme-color) never renders.
import { shell } from '@wave-av/spoke-chassis';
import { TOKENS_CSS } from './tokens.css';

export const LANDING_INNER = `<div class="hero">
<div class="kicker">WAVE · MoQ Edge</div>
<h1>Your live stream stops arriving late.</h1>
<p class="lead">moq-edge moves live media sub-second across Cloudflare's global edge — publish a track, subscribe to it, and every viewer sees the moment while it's still the moment. Live now on IETF MoQ draft-18. MIT open source.</p>
<div class="gfx" aria-hidden="true"><svg viewBox="0 0 360 72" xmlns="http://www.w3.org/2000/svg">
<line class="gfx-track" x1="6" y1="36" x2="330" y2="36"/>
<g class="gfx-now"><rect x="330" y="8" width="4" height="56" rx="2"/></g>
<g class="gfx-pkt"><rect x="6" y="30" width="10" height="10" rx="2" style="animation-delay:0ms"/></g>
<g class="gfx-pkt"><rect x="6" y="30" width="10" height="10" rx="2" style="animation-delay:200ms"/></g>
<g class="gfx-pkt"><rect x="6" y="30" width="10" height="10" rx="2" style="animation-delay:400ms"/></g>
<g class="gfx-pkt"><rect x="6" y="30" width="10" height="10" rx="2" style="animation-delay:600ms"/></g>
</svg></div>
<div class="btns">
  <a class="btn primary" href="https://github.com/wave-av/wave-moq-edge#quick-start">Publish your first track →</a>
  <a class="btn ghost" href="https://wave.online/enterprise">Talk to sales</a>
</div>
</div>

<h2>No CDN to build. No HLS to stitch.</h2>
<p class="sub">It's live right now at moq.wave.online on IETF MoQ <span class="acc">draft-18</span> — the current working draft, not a someday. One Durable Object per track is the rendezvous: publishers write to it, and the edge fans each object out to every subscriber across Cloudflare's global network. You bring the encoder; WAVE moves the frames sub-second. <span class="good">MIT open source — read every byte.</span></p>
<div class="row"><span class="k">publish track</span><span class="dim">POST <span class="acc">/v1/publish/:namespace/:track</span></span></div>
<div class="row"><span class="k">subscribe to track</span><span class="dim">GET <span class="acc">/v1/subscribe/:namespace/:track</span></span></div>
<div class="row"><span class="k">track metadata</span><span class="dim">GET <span class="acc">/v1/track/:namespace/:track</span></span></div>
<div class="row"><span class="k">active tracks</span><span class="dim">GET <span class="acc">/v1/announce</span></span></div>
<div class="row"><span class="k">MoQ catalog</span><span class="dim">GET <span class="acc">/v1/catalog</span></span></div>
<div class="row"><span class="k">liveness</span><span class="dim">GET <span class="acc">/health</span></span></div>

<h2>The fast floor under the WAVE stack</h2>
<p class="sub">moq-edge is the bottom layer of the WAVE stack — pure transport that moves bytes and nothing else. Everything else composes on top: capability-token auth (<span class="acc">moq:read</span> / <span class="acc">moq:write</span> scopes), recording-to-R2 for replay, per-client bitrate, analytics, and protocol adapters that bridge WebRTC, SRT, and HLS-LL into the same MoQ plane. One live-media substrate for the agentic internet.</p>
<p class="sub" style="margin-top:1.4rem">Open source under MIT. Canonical source at
  <a href="https://github.com/wave-av/wave-moq-edge" rel="noopener">github.com/wave-av/wave-moq-edge</a>.
  Spec compliance reports and interop testing welcome.</p>`;

export function landingPage(): string {
  return shell({
    product: 'Media over QUIC',
    title: 'Your live stream stops arriving late — WAVE MoQ Edge',
    description: 'moq-edge moves live media sub-second across Cloudflare\'s global edge — publish a track, subscribe to it, and every viewer sees the moment while it\'s still the moment. Live now on IETF MoQ draft-18. MIT open source.',
    url: 'https://moq.wave.online',
    keywords: 'MoQ, live streaming, low latency, sub-second, IETF draft-18, edge relay, WAVE',
    inner: LANDING_INNER,
    tokensCss: TOKENS_CSS,
    accentHex: '#00d4d5',
    ldHost: 'moq.wave.online',
    ldTagline: 'Your live stream stops arriving late.',
    cta: {
      primaryLabel: 'Publish your first track →',
      primaryHref: 'https://github.com/wave-av/wave-moq-edge#quick-start',
      salesLabel: 'Talk to sales',
      salesHref: 'https://wave.online/enterprise',
      phrases: ['Publish a track', 'Subscribe globally', 'Sub-second latency', 'IETF draft-18', 'Durable Object fan-out'],
    },
  });
}
