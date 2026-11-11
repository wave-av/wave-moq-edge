/**
 * Spoke-edge guard for chassis 0.20.x unmatched-path federation (WAVE-33500).
 *
 * `makeFetch` resolves leftover pathnames with `new URL(path, origin)`. A
 * scheme-relative pathname (`//host/...`) is a valid URL path on this Worker
 * (it is not `/v1/*`, `/health`, or `/metrics`) and that constructor then
 * leaves the gateway / request origin. Refuse those paths here until the
 * Worker can pin `@wave-av/spoke-chassis` 0.20.5+ and redeploy.
 */

/** True when `pathname` would let chassis 0.20.x federate off-origin. */
export function isUnsafeFederationPath(pathname: string): boolean {
  return pathname.startsWith('//');
}
