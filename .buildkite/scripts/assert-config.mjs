/* global process, console */
// assert-config.mjs <wrangler.toml> <smol-toml entry>: fail unless env.staging and env.production
// both set workers_dev = false and preview_urls = false and declare a route.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [, , tomlPath, smolPath] = process.argv;
const { parse } = await import(pathToFileURL(smolPath).href);
const cfg = parse(readFileSync(tomlPath, 'utf8'));
let bad = 0;
for (const env of ['staging', 'production']) {
  const e = cfg.env?.[env];
  const problems = [];
  if (!e) problems.push('missing [env.' + env + ']');
  else {
    if (e.workers_dev !== false) problems.push('workers_dev must be false (got ' + e.workers_dev + ')');
    if (e.preview_urls !== false) problems.push('preview_urls must be false (got ' + e.preview_urls + ')');
    if (!e.route && !(Array.isArray(e.routes) && e.routes.length)) problems.push('no route/routes');
  }
  if (problems.length) { bad++; console.error(`env.${env}: ` + problems.join('; ')); }
  else console.log(`env.${env}: workers_dev=false preview_urls=false route=${JSON.stringify(e.route ?? e.routes)}`);
}
process.exit(bad ? 1 : 0);
