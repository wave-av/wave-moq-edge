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
<line class="gfx-grid" x1="126" y1="51" x2="126" y2="57"/>
<line class="gfx-grid" x1="154" y1="51" x2="154" y2="57"/>
<line class="gfx-grid" x1="182" y1="51" x2="182" y2="57"/>
<line class="gfx-grid" x1="210" y1="51" x2="210" y2="57"/>
<line class="gfx-grid" x1="238" y1="51" x2="238" y2="57"/>
<line class="gfx-grid" x1="266" y1="51" x2="266" y2="57"/>
<line class="gfx-grid" x1="294" y1="51" x2="294" y2="57"/>
<line class="gfx-grid" x1="322" y1="51" x2="322" y2="57"/>
<g class="gfx-pkt p1"><rect x="126" y="50" width="8" height="8" rx="2"/></g>
<g class="gfx-pkt p2"><rect x="154" y="50" width="8" height="8" rx="2"/></g>
<g class="gfx-pkt p3"><rect x="182" y="50" width="8" height="8" rx="2"/></g>
<g class="gfx-pkt p4"><rect x="210" y="50" width="8" height="8" rx="2"/></g>
<line class="gfx-plane" x1="6" y1="54" x2="354" y2="54"/>
<circle class="gfx-crest" cx="6" cy="54" r="3"/>
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
