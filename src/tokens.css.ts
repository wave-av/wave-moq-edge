// moq.wave.online — local token override so this spoke can carry a bespoke hero graphic.
// The shared @wave-av/spoke-chassis `shell()` accepts a `tokensCss` string that replaces its
// default `:root{...}` block verbatim inside <style> — so this file starts from the identical
// chassis default (no visual change to existing tokens) and appends the `.gfx` motif CSS after it,
// exactly like the pattern used in sibling spokes (e.g. wave-voice-edge/src/tokens.css.ts).
export const TOKENS_CSS = `:root{--bg:#0b0f14;--fg:#cfe3f7;--fg-strong:#fff;--dim:#5b7287;--acc:oklch(0.78 0.15 220);--warn:#e6b450;--card:#0e141b;--line:#1c2733}
::selection{background:var(--acc);color:var(--bg)}
.gfx{display:flex;justify-content:center;margin:1.5rem 0 .6rem}
.gfx svg{width:min(360px,92%);height:auto}
.gfx-plane{stroke:#fff;stroke-opacity:.12;stroke-width:1}
.gfx-crest{fill:var(--acc);filter:drop-shadow(0 0 4px var(--acc));animation:gfxcrest 6s cubic-bezier(.4,0,.2,1) infinite}
@keyframes gfxcrest{0%{transform:translateX(0);opacity:0}6%{opacity:1}90%{opacity:1}100%{transform:translateX(348px);opacity:0}}
.gfx-grid{stroke:var(--dim);stroke-width:1;opacity:.35}
.gfx-pkt rect{fill:var(--acc);transform-box:fill-box;transform-origin:center}
.gfx-pkt.p1 rect{animation:gfxpkt1 6s cubic-bezier(.4,0,.2,1) infinite}
.gfx-pkt.p2 rect{animation:gfxpkt2 6s cubic-bezier(.4,0,.2,1) infinite}
.gfx-pkt.p3 rect{animation:gfxpkt3 6s cubic-bezier(.4,0,.2,1) infinite}
.gfx-pkt.p4 rect{animation:gfxpkt4 6s cubic-bezier(.4,0,.2,1) infinite}
@keyframes gfxpkt1{0%{transform:translate(-150px,-16px);opacity:0}5%{opacity:1}14%{transform:translate(-118px,10px)}26%{transform:translate(-82px,-12px)}38%{transform:translate(-40px,8px)}48%{transform:translate(-8px,-4px)}50%{transform:translate(0,0)}65%{transform:translate(52px,0)}80%{transform:translate(104px,0)}92%{transform:translate(148px,0);opacity:1}100%{transform:translate(160px,0);opacity:0}}
@keyframes gfxpkt2{0%{transform:translate(-150px,12px);opacity:0}9%{opacity:1}20%{transform:translate(-112px,-14px)}32%{transform:translate(-70px,9px)}42%{transform:translate(-30px,-7px)}49%{transform:translate(-6px,3px)}50%{transform:translate(0,0)}65%{transform:translate(52px,0)}80%{transform:translate(104px,0)}92%{transform:translate(148px,0);opacity:1}100%{transform:translate(160px,0);opacity:0}}
@keyframes gfxpkt3{0%{transform:translate(-150px,-10px);opacity:0}3%{opacity:1}16%{transform:translate(-100px,14px)}30%{transform:translate(-64px,-9px)}40%{transform:translate(-22px,11px)}48%{transform:translate(-5px,-3px)}50%{transform:translate(0,0)}65%{transform:translate(52px,0)}80%{transform:translate(104px,0)}92%{transform:translate(148px,0);opacity:1}100%{transform:translate(160px,0);opacity:0}}
@keyframes gfxpkt4{0%{transform:translate(-150px,15px);opacity:0}13%{opacity:1}24%{transform:translate(-96px,-13px)}36%{transform:translate(-58px,10px)}44%{transform:translate(-18px,-8px)}49%{transform:translate(-4px,4px)}50%{transform:translate(0,0)}65%{transform:translate(52px,0)}80%{transform:translate(104px,0)}92%{transform:translate(148px,0);opacity:1}100%{transform:translate(160px,0);opacity:0}}
@media(prefers-reduced-motion:reduce){.gfx-pkt rect{animation:none;transform:translate(0,0);opacity:1}.gfx-crest{animation:none;transform:translateX(174px)}}`;
