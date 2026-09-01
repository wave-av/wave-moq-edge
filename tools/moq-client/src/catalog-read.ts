/**
 * #213 — the bench's client-side half of `GET /v1/catalog` observability.
 *
 * Split out of `bench-sixteen-track.ts` (file-size gate) so the catalog-read root-cause fix has one
 * clearly-owned home.
 *
 * #213 ROOT CAUSE (by-design, not a relay bug): the production relay runs `MOQ_REQUIRE_AUTH=true` +
 * `MOQ_DISCOVERY_JOIN=true` (wrangler.toml `[env.production.vars]`). `/v1/catalog` fail-closes to an
 * EMPTY list for any request that carries no discovery credential (src/wave-auth.ts
 * `filterTracksForOrg`: `if (!org) return [];`; src/moq-discovery-auth.ts `filterTracksForJoin`:
 * `if (!verdict.ok) return [];`) — deliberate tenant isolation, not a gap in announce/registration
 * (`handlePublish` in index.ts DOES write every bench track into `MOQ_TRACK_REGISTRY` on publish; the
 * relay side proves this out in `__tests__/discovery-join-endpoints.test.ts`). A caller with no org
 * header and no join-token is, by the relay's own design, indistinguishable from an anonymous
 * directory scrape — so it sees nothing, no matter how many tracks are live.
 *
 * #112 already built the fix for exactly this shape of caller: a join-token minted for ANY track in a
 * namespace is a valid `moq:read` discovery credential for the WHOLE namespace it is bound to
 * (src/moq-discovery-auth.ts `filterTracksForJoin` matches on `verdict.ns`, not the specific track).
 * `readCatalog`'s `joinToken` param, when supplied, is attached as `?join=` (the same carrier
 * `extractJoinToken` reads for publish/subscribe) so a bench run that already mints join-tokens for
 * its own tracks can present one of them here and see its own namespace's live tracks — the intended
 * use case from the #112 doc comment ("a publisher/viewer can enumerate the sibling tracks of the
 * stream it is already authorized for"). No `joinToken` → unauthenticated request, byte-identical to
 * the pre-fix behavior (so this stays a strict superset, never a behavior change for callers that
 * don't opt in).
 */

export interface CatalogTrackSummary {
  namespace: string;
  track: string;
}

export interface CatalogReadResult {
  status: number;
  tracks: CatalogTrackSummary[];
  raw: unknown;
}

export async function readCatalog(relayBase: string, joinToken?: string): Promise<CatalogReadResult> {
  const url = new URL('/v1/catalog', relayBase);
  if (joinToken) url.searchParams.set('join', joinToken);
  const res = await fetch(url.toString());
  const raw = await res.json().catch(() => null);
  // catalogformat §3.2.4: a namespace shared by EVERY track in the document is hoisted into
  // `commonTrackFields.namespace` and dropped from each per-track entry (src/catalog.ts
  // `buildMsfCatalog`) — spec-correct, and exactly the shape a single bench run produces (every
  // track shares one run-scoped namespace). Fall back to the hoisted value so a spec-shaped,
  // single-namespace response still resolves each track's namespace instead of reading `''` and
  // silently undercounting `benchTracksLive` even when the catalog read itself succeeded.
  const commonNamespace = (raw as { commonTrackFields?: { namespace?: string } } | null)?.commonTrackFields?.namespace;
  const tracks: CatalogTrackSummary[] = Array.isArray((raw as { tracks?: unknown })?.tracks)
    ? (raw as { tracks: Array<{ namespace?: string; name?: string }> }).tracks.map((t) => ({
        namespace: t.namespace ?? commonNamespace ?? '',
        track: t.name ?? '',
      }))
    : [];
  return { status: res.status, tracks, raw };
}
