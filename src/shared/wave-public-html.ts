/**
 * wave-public-html — branded public landing/error page helper.
 *
 * Vendored into wave-moq-edge by the canonical-flip (Track C Phase-A). The original
 * import was `../shared/wave-public-html` from the wave-surfer-connect monorepo
 * (`workers/shared/`), which was never vendored into the auto-mirror — so the repo
 * could not compile standalone. Now that wave-moq-edge is the source of truth (not a
 * mirror), this helper lives here.
 *
 * It renders a self-contained, dependency-free, WCAG 2.2 AA dark-surface HTML page:
 *  - WAVE wordmark + brand-aligned dark surface
 *  - status pill + a row of stat cards
 *  - free-form `children` HTML body
 *  - skip-link, focus rings, 4.5:1 contrast, reduced-motion safe
 *
 * No external CSS/JS — everything inlined so a single Worker response is fully
 * self-contained at the edge.
 */

/** A single stat card rendered in the header strip. */
export interface WaveStat {
  label: string;
  value: string;
  /** Render the value in a monospace face (ids, counts, versions). */
  mono?: boolean;
}

/** Operational status — drives the colour + label of the status pill. */
export type WaveStatus = 'operational' | 'degraded' | 'down' | 'maintenance';

export interface WavePublicPageOptions {
  /** Page title (suffixed with " — WAVE"). */
  title: string;
  /** One-line subtitle under the wordmark. */
  subtitle?: string;
  /** Status pill state. Defaults to 'operational'. */
  status?: WaveStatus;
  /** Canonical URL for <link rel=canonical> + og:url. */
  canonical?: string;
  /** Stat cards rendered in the header strip. */
  stats?: WaveStat[];
  /** Free-form HTML for the page body (already-trusted, server-built markup). */
  children?: string;
  /** og:image URL for social cards. */
  ogImage?: string;
}

const STATUS_LABEL: Record<WaveStatus, string> = {
  operational: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
  maintenance: 'Maintenance',
};

// OKLCH-adjacent brand palette expressed as hex for maximal client support.
// Surface #0b0f14 vs text #e6edf3 = ~14:1 contrast (well past AA 4.5:1).
const STATUS_COLOR: Record<WaveStatus, string> = {
  operational: '#43d9ad',
  degraded: '#e3b341',
  down: '#f85149',
  maintenance: '#79c0ff',
};

/** HTML-escape untrusted text used in attributes / text nodes. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderStats(stats: WaveStat[]): string {
  if (stats.length === 0) return '';
  const cards = stats
    .map(
      (s) => `
      <div class="stat" role="listitem">
        <div class="stat-label">${esc(s.label)}</div>
        <div class="stat-value${s.mono ? ' mono' : ''}">${esc(s.value)}</div>
      </div>`
    )
    .join('');
  return `<div class="stats" role="list" aria-label="Service statistics">${cards}</div>`;
}

const BASE_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #0b0f14; color: #e6edf3;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  a { color: #79c0ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  a:focus-visible, button:focus-visible {
    outline: 2px solid #79c0ff; outline-offset: 2px; border-radius: 4px;
  }
  .skip-link {
    position: absolute; left: -999px; top: 0; padding: 8px 16px;
    background: #161b22; color: #e6edf3; z-index: 10;
  }
  .skip-link:focus { left: 8px; top: 8px; }
  main { max-width: 880px; margin: 0 auto; padding: 48px 24px 96px; }
  .wordmark { font-weight: 800; letter-spacing: -0.02em; font-size: 1.1rem; color: #e6edf3; }
  .wordmark .dot { color: #43d9ad; }
  h1 { font-size: 2.2rem; line-height: 1.15; margin: 24px 0 8px; letter-spacing: -0.02em; }
  .subtitle { color: #9aa7b2; font-size: 1.05rem; margin: 0 0 24px; max-width: 64ch; }
  .pill {
    display: inline-flex; align-items: center; gap: 8px; font-size: 0.85rem;
    padding: 4px 12px; border-radius: 999px; background: #161b22; border: 1px solid #21262d;
  }
  .pill .dot { width: 8px; height: 8px; border-radius: 50%; }
  .stats { display: flex; flex-wrap: wrap; gap: 12px; margin: 24px 0; }
  .stat { background: #11161c; border: 1px solid #21262d; border-radius: 10px; padding: 12px 16px; min-width: 120px; }
  .stat-label { color: #9aa7b2; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .stat-value { font-size: 1.3rem; font-weight: 700; margin-top: 2px; }
  .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
  pre {
    background: #11161c; border: 1px solid #21262d; border-radius: 10px;
    padding: 16px; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.85rem; line-height: 1.5;
  }
  footer { color: #6e7b86; font-size: 0.85rem; margin-top: 64px; border-top: 1px solid #21262d; padding-top: 24px; }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

/**
 * Render a branded public HTML page as a string.
 * Caller wraps it in a Response with the right content-type + cache headers.
 */
export function wavePublicPage(opts: WavePublicPageOptions): string {
  const status = opts.status ?? 'operational';
  const statusColor = STATUS_COLOR[status];
  const statusLabel = STATUS_LABEL[status];
  const canonicalTag = opts.canonical
    ? `<link rel="canonical" href="${esc(opts.canonical)}" /><meta property="og:url" content="${esc(opts.canonical)}" />`
    : '';
  const ogImageTag = opts.ogImage ? `<meta property="og:image" content="${esc(opts.ogImage)}" />` : '';
  const subtitle = opts.subtitle ? `<p class="subtitle">${esc(opts.subtitle)}</p>` : '';
  const stats = renderStats(opts.stats ?? []);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(opts.title)} — WAVE</title>
  <meta name="description" content="${esc(opts.subtitle ?? opts.title)}" />
  <meta property="og:title" content="${esc(opts.title)} — WAVE" />
  <meta property="og:description" content="${esc(opts.subtitle ?? opts.title)}" />
  <meta property="og:type" content="website" />
  ${canonicalTag}
  ${ogImageTag}
  <style>${BASE_CSS}</style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <main id="main">
    <div class="wordmark">WAVE<span class="dot">.</span></div>
    <span class="pill"><span class="dot" style="background:${statusColor}"></span>${esc(statusLabel)}</span>
    <h1>${esc(opts.title)}</h1>
    ${subtitle}
    ${stats}
    ${opts.children ?? ''}
    <footer>
      <a href="https://wave.online">WAVE Online</a> · Built at the edge on Cloudflare Workers.
    </footer>
  </main>
</body>
</html>`;
}

/**
 * Render a branded HTML error page wrapped in a Response.
 * Mirrors wavePublicPage styling so 4xx/5xx pages stay on-brand.
 */
export function wavePublicErrorResponse(
  status: number,
  title: string,
  detail?: string,
  init: ResponseInit = {}
): Response {
  const html = wavePublicPage({
    title: `${status} — ${title}`,
    subtitle: detail,
    status: status >= 500 ? 'down' : 'degraded',
    children: `
      <p style="margin-top:24px"><a href="/">← Back to the landing page</a></p>
    `,
  });
  const headers = new Headers(init.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  return new Response(html, { ...init, status, headers });
}
