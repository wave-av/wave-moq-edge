/**
 * Gateway join-token mint helper, shared by the CLI (`cli.ts`) and the 16-track bench
 * (`bench-sixteen-track.ts`).
 *
 * The production relay (`src/moq-join-verify.ts`) binds every join token to an EXACT (ns, track)
 * pair at mint time — no prefix/wildcard match, IDOR closed (#58). A token minted for one ns/track
 * can never authorize a different ns/track, so every caller that talks to more than one track needs
 * one mint call PER (role, ns, track) — never a single token reused across tracks.
 *
 * Pattern lifted from `examples/server-publisher.ts`'s `mintJoinToken` (which stays a standalone,
 * zero-dep single file by design — this module is the shared version other TS tooling should import
 * instead of duplicating the fetch/parse logic again).
 */

export interface MintJoinTokenOpts {
  gateway: string;
  role: 'publish' | 'subscribe';
  ns: string;
  track: string;
  apiKey: string;
}

/** Ask the WAVE gateway to authorize this caller for ns/track and mint a short-lived join token. */
export async function mintJoinToken(opts: MintJoinTokenOpts): Promise<string> {
  const { gateway, role, ns, track, apiKey } = opts;
  const url = `${gateway.replace(/\/$/, '')}/v1/moq/${role}/${encodeURIComponent(ns)}/${encodeURIComponent(track)}`;
  const attempts: Array<'POST' | 'GET'> = role === 'publish' ? ['POST', 'GET'] : ['GET', 'POST'];
  let lastDetail = '';
  for (const method of attempts) {
    const res = await fetch(url, { method, headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' } });
    const body = await res.text();
    if (res.ok) {
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(body) as Record<string, unknown>;
      } catch {
        throw new Error(`mint ${method} ${url} returned ${res.status} with a non-JSON body`);
      }
      const token = (json.joinToken ?? json.join_token ?? json.token ?? json.join) as string | undefined;
      if (!token) throw new Error(`mint ${method} ${url} returned ${res.status} but no joinToken field (keys: ${Object.keys(json).join(', ')})`);
      return token;
    }
    lastDetail = `${method} ${url} → ${res.status} ${res.statusText}: ${body.slice(0, 300)}`;
    if (res.status !== 404 && res.status !== 405) break; // only a routing miss is worth retrying with the other verb
  }
  throw new Error(
    `could not mint a MoQ join token for ${role} ${ns}/${track}.\n  ${lastDetail}\n` +
      `  401/403 → the key lacks moq:write/moq:read for this namespace.\n` +
      `  402     → the account has no MoQ entitlement.\n`,
  );
}
