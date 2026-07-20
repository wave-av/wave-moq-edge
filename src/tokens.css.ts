// moq.wave.online — local token override so this spoke can carry a bespoke hero graphic.
// The shared @wave-av/spoke-chassis `shell()` accepts a `tokensCss` string that replaces its
// default `:root{...}` block verbatim inside <style> — so this file starts from the identical
// chassis default (no visual change to existing tokens) and appends the `.gfx` motif CSS after it,
// exactly like the pattern used in sibling spokes (e.g. wave-voice-edge/src/tokens.css.ts).
export const TOKENS_CSS = `:root{--bg:#0b0f14;--fg:#cfe3f7;--fg-strong:#fff;--dim:#5b7287;--acc:oklch(0.78 0.15 220);--warn:#e6b450;--card:#0e141b;--line:#1c2733}
::selection{background:var(--acc);color:var(--bg)}
.gfx{display:flex;justify-content:center;margin:1.5rem 0 .6rem}
.gfx svg{width:min(360px,90%);height:auto}
.gfx-track{stroke:var(--dim);stroke-width:2;stroke-linecap:round;opacity:.6}
.gfx-now rect{fill:var(--acc);transform-box:fill-box;transform-origin:center;animation:gfxnow 200ms linear infinite;animation-delay:80ms}
.gfx-pkt rect{fill:var(--acc);transform-box:fill-box;transform-origin:center;animation:gfxpkt 800ms cubic-bezier(.2,.7,.3,1) infinite}
@keyframes gfxpkt{0%{transform:translateX(0);opacity:0}5%{opacity:1}85%{transform:translateX(322px);opacity:1}90%{transform:translateX(322px);opacity:1}94%{opacity:0}100%{opacity:0;transform:translateX(322px)}}
@keyframes gfxnow{0%{opacity:1;transform:scaleY(1.15)}15%{opacity:.4;transform:scaleY(1)}100%{opacity:.4;transform:scaleY(1)}}
@media(prefers-reduced-motion:reduce){.gfx-pkt rect,.gfx-now rect{animation:none}.gfx-now rect{opacity:1;transform:scaleY(1)}.gfx-pkt:nth-of-type(1) rect{transform:translateX(0);opacity:1}.gfx-pkt:nth-of-type(2) rect{transform:translateX(110px);opacity:1}.gfx-pkt:nth-of-type(3) rect{transform:translateX(220px);opacity:1}.gfx-pkt:nth-of-type(4) rect{transform:translateX(322px);opacity:1}}`;
