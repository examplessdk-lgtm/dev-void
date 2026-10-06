import { isRecord } from './is-record.ts';

export const MANIFEST_REDIRECT_RULE_STATUSES: ReadonlySet<number> = new Set([
  200, 301, 302, 303, 307, 308,
]);

// Caps on user-supplied routing rule lists. Each rule compiles a regex per
// request in dispatch (see `routing-rules.ts`), so an unbounded list lets a
// 100k-entry manifest exhaust CPU on every request to the project. The limit
// is per-list (redirect + fallback are independent), well above what real
// frameworks emit (Vercel/Netlify both ship in the low thousands at most),
// and validated at deploy ingest so dispatch never sees an oversized list.
export const MAX_ROUTING_RULES = 2000;
export const MAX_REVALIDATE_QUERY_ALLOWLIST_ENTRIES: number = MAX_ROUTING_RULES;
const MAX_PAGES = 5000;

/**
 * Strict literal-hostname regex used to validate `redirectRules[].host` /
 * `fallbackRules[].host` on the deploy manifest. Mirrors the regex in
 * `routes/domains.ts` (custom-domain create endpoint) — the source of truth
 * for what counts as a valid project-owned hostname. Rejects scheme prefixes,
 * ports, paths, whitespace, control chars, wildcards, single-label hosts,
 * IPv4 literals, and userinfo. Hostnames are lowercased before testing so
 * the same byte-exact form is what dispatch compares against `url.hostname`
 * (also lowercase per WHATWG).
 */
const LITERAL_HOSTNAME_REGEX = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * Validate and lowercase-normalize an optional `host` field on a redirect or
 * fallback rule. Mutates `ruleObject.host` in place so the persisted manifest carries
 * the canonical form. Returns an error message string on failure, or `null`
 * on success (including the absent-field case).
 */
function validateRuleHost(
  ruleObject: Record<string, unknown>,
  ruleKind: 'redirectRules' | 'fallbackRules',
  sourceRef: string,
): string | null {
  if (ruleObject.host === undefined) {
    return null;
  }
  if (typeof ruleObject.host !== 'string') {
    return `invalid manifest shape: ${ruleKind} entry ${sourceRef} host must be a string`;
  }
  const normalized = ruleObject.host.toLowerCase();
  if (!LITERAL_HOSTNAME_REGEX.test(normalized)) {
    return `invalid manifest shape: ${ruleKind} entry ${sourceRef} host must be a literal hostname (e.g. "www.example.com"; no scheme, port, path, or wildcards): ${JSON.stringify(ruleObject.host)}`;
  }
  ruleObject.host = normalized;
  return null;
}

/**
 * Runtime shape validation for incoming deploy manifests. Downstream code
 * indexes deeply into the manifest (bindings.d1, queues[i].name,
 * websocket.classes, etc.) without re-guarding, so a malformed-but-JSON-valid
 * payload would otherwise crash with a 500 — sometimes after a deployment row
 * or CF resources were created. Everything the deploy pipeline reads must be
 * validated here BEFORE createDeployment runs.
 */
export function validateManifestShape(parsed: unknown): string | null {
  if (!isRecord(parsed)) {
    return 'invalid manifest shape: expected a JSON object';
  }
  const manifest = parsed;
  if (manifest.emailProtocolVersion !== undefined && manifest.emailProtocolVersion !== 1) {
    return 'invalid manifest shape: emailProtocolVersion must be 1';
  }

  if (!isRecord(manifest.bindings)) {
    return 'invalid manifest shape: bindings must be an object';
  }
  const bindings = manifest.bindings;
  for (const key of ['d1', 'kv', 'r2', 'hyperdrive'] as const) {
    const bindingValue = bindings[key];
    if (bindingValue === undefined) {
      continue;
    }
    if (!Array.isArray(bindingValue) || !bindingValue.every((value) => typeof value === 'string')) {
      return `invalid manifest shape: bindings.${key} must be an array of strings`;
    }
  }

  if (manifest.queues !== undefined) {
    if (!Array.isArray(manifest.queues)) {
      return 'invalid manifest shape: queues must be an array';
    }
    for (const queue of manifest.queues) {
      if (!isRecord(queue)) {
        return 'invalid manifest shape: queues entries must be objects';
      }
      const queueObject = queue;
      if (typeof queueObject.name !== 'string' || typeof queueObject.bindingName !== 'string') {
        return 'invalid manifest shape: queues entries must have string name and bindingName';
      }
      for (const tuning of [
        'maxBatchSize',
        'maxBatchTimeout',
        'maxRetries',
        'retryDelay',
      ] as const) {
        const tuningValue = queueObject[tuning];
        if (tuningValue === undefined) {
          continue;
        }
        if (typeof tuningValue !== 'number' || !Number.isFinite(tuningValue)) {
          return `invalid manifest shape: queues entry ${tuning} must be a finite number`;
        }
      }
    }
  }

  if (manifest.schedules !== undefined) {
    if (!Array.isArray(manifest.schedules)) {
      return 'invalid manifest shape: schedules must be an array';
    }
    for (const schedule of manifest.schedules) {
      if (!isRecord(schedule)) {
        return 'invalid manifest shape: schedules entries must be objects';
      }
      const scheduleObject = schedule;
      if (typeof scheduleObject.name !== 'string' || typeof scheduleObject.cron !== 'string') {
        return 'invalid manifest shape: schedules entries must have string name and cron';
      }
    }
  }

  if (manifest.prerender !== undefined) {
    if (
      !Array.isArray(manifest.prerender) ||
      !manifest.prerender.every((x) => typeof x === 'string')
    ) {
      return 'invalid manifest shape: prerender must be an array of strings';
    }
  }

  if (manifest.vars !== undefined) {
    if (!isRecord(manifest.vars)) {
      return 'invalid manifest shape: vars must be an object';
    }
    for (const [k, v] of Object.entries(manifest.vars)) {
      if (typeof v !== 'string') {
        return `invalid manifest shape: vars.${k} must be a string`;
      }
    }
  }

  if (manifest.migrations !== undefined) {
    if (!isRecord(manifest.migrations)) {
      return 'invalid manifest shape: migrations must be an object';
    }
    const mig = manifest.migrations;
    // `dialect` and `pending` are read unconditionally by the migration
    // dispatch path (`manifest.migrations.pending > 0`). A wrong-typed value
    // would reach the CF migration runner and crash mid-deploy.
    if (mig.dialect !== undefined) {
      const allowed = ['sqlite', 'postgresql', 'mysql'];
      if (typeof mig.dialect !== 'string' || !allowed.includes(mig.dialect)) {
        return `invalid manifest shape: migrations.dialect must be one of ${allowed.join(', ')}`;
      }
    }
    if (mig.pending !== undefined) {
      if (typeof mig.pending !== 'number' || !Number.isInteger(mig.pending) || mig.pending < 0) {
        return 'invalid manifest shape: migrations.pending must be a non-negative integer';
      }
    }
    if (mig.protocolVersion !== undefined && mig.protocolVersion !== 2) {
      return 'invalid manifest shape: migrations.protocolVersion must be 2';
    }
    if (
      mig.classifierVersion !== undefined &&
      (typeof mig.classifierVersion !== 'number' || !Number.isInteger(mig.classifierVersion))
    ) {
      return 'invalid manifest shape: migrations.classifierVersion must be an integer';
    }
    if (mig.migrationListHash !== undefined && typeof mig.migrationListHash !== 'string') {
      return 'invalid manifest shape: migrations.migrationListHash must be a string';
    }
    if (mig.stability !== undefined && mig.stability !== 'stable' && mig.stability !== 'legacy') {
      return 'invalid manifest shape: migrations.stability must be stable or legacy';
    }
  }

  if (manifest.auth !== undefined && typeof manifest.auth !== 'boolean') {
    return 'invalid manifest shape: auth must be a boolean';
  }

  if (manifest.ssr !== undefined && typeof manifest.ssr !== 'boolean') {
    return 'invalid manifest shape: ssr must be a boolean';
  }

  for (const key of [
    'workerMain',
    'compatibilityDate',
    'hashedAssetsPrefix',
    'framework',
  ] as const) {
    if (manifest[key] !== undefined && typeof manifest[key] !== 'string') {
      return `invalid manifest shape: ${key} must be a string`;
    }
  }

  if (manifest.assetManifestVersion !== undefined) {
    // Direct-to-R2 deploys require v2 (declares blake3 + md5 + size per asset).
    // The handler enforces v2 with its own error message; this shape check
    // accepts 1 here so the layered error is the one users see.
    if (manifest.assetManifestVersion !== 1 && manifest.assetManifestVersion !== 2) {
      return 'invalid manifest shape: assetManifestVersion must be 1 or 2';
    }
  }

  if (manifest.compatibilityFlags !== undefined) {
    if (
      !Array.isArray(manifest.compatibilityFlags) ||
      !manifest.compatibilityFlags.every((x) => typeof x === 'string')
    ) {
      return 'invalid manifest shape: compatibilityFlags must be an array of strings';
    }
  }

  // Per-project worker limit overrides (void.json `worker.limits`). Shape-only
  // here; the plan ceiling (`maxCpuMsPerRequest`) is enforced by the deploy
  // handler once the authenticated user's plan is in scope.
  if (manifest.limits !== undefined) {
    if (!isRecord(manifest.limits)) {
      return 'invalid manifest shape: limits must be an object';
    }
    const limits = manifest.limits;
    if (limits.cpuMs !== undefined) {
      if (
        typeof limits.cpuMs !== 'number' ||
        !Number.isSafeInteger(limits.cpuMs) ||
        limits.cpuMs < 1
      ) {
        return 'invalid manifest shape: limits.cpuMs must be a positive integer';
      }
    }
  }

  if (manifest.type !== undefined) {
    const allowed = ['void', 'spa', 'static', 'framework'];
    if (typeof manifest.type !== 'string' || !allowed.includes(manifest.type)) {
      return `invalid manifest shape: type must be one of ${allowed.join(', ')}`;
    }
  }

  if (manifest.assetConfig !== undefined) {
    if (!isRecord(manifest.assetConfig)) {
      return 'invalid manifest shape: assetConfig must be an object';
    }
    const assetConfig = manifest.assetConfig;
    if (
      assetConfig.not_found_handling !== undefined &&
      !['none', 'single-page-application', '404-page'].includes(
        assetConfig.not_found_handling as string,
      )
    ) {
      return 'invalid manifest shape: assetConfig.not_found_handling must be one of none, single-page-application, 404-page';
    }
    if (
      assetConfig.html_handling !== undefined &&
      !['auto-trailing-slash', 'force-trailing-slash', 'drop-trailing-slash', 'none'].includes(
        assetConfig.html_handling as string,
      )
    ) {
      return 'invalid manifest shape: assetConfig.html_handling must be one of auto-trailing-slash, force-trailing-slash, drop-trailing-slash, none';
    }
  }

  if (manifest.revalidate !== undefined) {
    if (typeof manifest.revalidate === 'number') {
      // ok
    } else if (!isRecord(manifest.revalidate)) {
      return 'invalid manifest shape: revalidate must be a number or object';
    } else {
      for (const [pathname, value] of Object.entries(manifest.revalidate)) {
        if (typeof value !== 'number') {
          return `invalid manifest shape: revalidate.${pathname} must be a number`;
        }
      }
    }
  }

  if (manifest.headerRules !== undefined) {
    if (!Array.isArray(manifest.headerRules)) {
      return 'invalid manifest shape: headerRules must be an array';
    }
    for (const rule of manifest.headerRules) {
      if (!isRecord(rule)) {
        return 'invalid manifest shape: headerRules entries must be objects';
      }
      const ruleObject = rule;
      if (typeof ruleObject.pattern !== 'string') {
        return 'invalid manifest shape: headerRules entries must have a string pattern';
      }
      if (!Array.isArray(ruleObject.headers)) {
        return 'invalid manifest shape: headerRules entries must have a headers array';
      }
      for (const pair of ruleObject.headers) {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          typeof pair[0] !== 'string' ||
          typeof pair[1] !== 'string'
        ) {
          return 'invalid manifest shape: headerRules headers entries must be [name, value] string pairs';
        }
      }
    }
  }

  // redirectRules is the pre-asset rule list. `status: 200` means a force
  // rewrite (internal URL rewrite, no Location header); `status: 3xx` means a
  // redirect. Destinations may not contain `?` — request query is merged
  // separately at dispatch time (see `mergeQueryIntoLocation`).
  if (manifest.redirectRules !== undefined) {
    if (!Array.isArray(manifest.redirectRules)) {
      return 'invalid manifest shape: redirectRules must be an array';
    }
    if (manifest.redirectRules.length > MAX_ROUTING_RULES) {
      return `invalid manifest shape: redirectRules has ${manifest.redirectRules.length} entries, exceeds the ${MAX_ROUTING_RULES} per-list limit`;
    }
    for (const rule of manifest.redirectRules) {
      if (!isRecord(rule)) {
        return 'invalid manifest shape: redirectRules entries must be objects';
      }
      const ruleObject = rule;
      if (
        typeof ruleObject.source !== 'string' ||
        typeof ruleObject.destination !== 'string' ||
        typeof ruleObject.status !== 'number'
      ) {
        return 'invalid manifest shape: redirectRules entries must have string source, string destination, and numeric status';
      }
      const sourceRef = JSON.stringify(ruleObject.source as string);
      if (!MANIFEST_REDIRECT_RULE_STATUSES.has(ruleObject.status)) {
        return `invalid manifest shape: redirectRules entry ${sourceRef} status must be one of ${[...MANIFEST_REDIRECT_RULE_STATUSES].join(', ')} (200 = rewrite, 3xx = redirect)`;
      }
      // Rewrites (status=200) must stay internal: no query string, path-absolute,
      // and not protocol-relative (`//evil.com/x` parses cross-origin). 3xx
      // redirects may include query strings and external Location values.
      const destination = ruleObject.destination as string;
      const isRewrite = ruleObject.status === 200;
      if (isRewrite && destination.includes('?')) {
        return `invalid manifest shape: redirectRules entry ${sourceRef} destination must not contain a query string when status is 200`;
      }
      if (isRewrite && !destination.startsWith('/')) {
        return `invalid manifest shape: redirectRules entry ${sourceRef} destination must be path-absolute (start with "/") when status is 200`;
      }
      if (isRewrite && destination.startsWith('//')) {
        return `invalid manifest shape: redirectRules entry ${sourceRef} destination must not start with "//" (protocol-relative URLs parse cross-origin; use a single-slash path-absolute destination)`;
      }
      const hostError = validateRuleHost(ruleObject, 'redirectRules', sourceRef);
      if (hostError) {
        return hostError;
      }
    }
  }

  // revalidateQueryAllowlist gates which query params participate in the
  // ISR variant key on a rewrite. Shape: `{ "<pathPattern>": ["param", …] }`.
  // The default (no entry / no allowlist) drops every param so a fanout
  // attack via `?utm=…`/`?cb=…` can't multiply cache slots. The validator
  // only enforces shape; semantic correctness (does the pattern match a
  // real route?) is the user's responsibility.
  if (manifest.revalidateQueryAllowlist !== undefined) {
    if (!isRecord(manifest.revalidateQueryAllowlist)) {
      return 'invalid manifest shape: revalidateQueryAllowlist must be an object';
    }
    const entries = Object.entries(manifest.revalidateQueryAllowlist);
    if (entries.length > MAX_REVALIDATE_QUERY_ALLOWLIST_ENTRIES) {
      return `invalid manifest shape: revalidateQueryAllowlist has ${entries.length} entries, exceeds the ${MAX_REVALIDATE_QUERY_ALLOWLIST_ENTRIES} entry limit`;
    }
    for (const [pattern, value] of entries) {
      if (pattern === '') {
        return 'invalid manifest shape: revalidateQueryAllowlist must not include an empty pattern';
      }
      if (!Array.isArray(value)) {
        return `invalid manifest shape: revalidateQueryAllowlist entry ${JSON.stringify(pattern)} must be an array of strings`;
      }
      for (const param of value) {
        if (typeof param !== 'string') {
          return `invalid manifest shape: revalidateQueryAllowlist entry ${JSON.stringify(pattern)} must contain only strings`;
        }
      }
    }
  }

  // pages is the ordered route table (`[{ pattern, revalidate? }]`) the
  // framework emits so dispatch can resolve a per-route ISR TTL by segment
  // pattern. Validator only enforces shape; the framework owns the ordering
  // and pattern semantics.
  if (manifest.pages !== undefined) {
    if (!Array.isArray(manifest.pages)) {
      return 'invalid manifest shape: pages must be an array';
    }
    if (manifest.pages.length > MAX_PAGES) {
      return `invalid manifest shape: pages has ${manifest.pages.length} entries, exceeds the ${MAX_PAGES} entry limit`;
    }
    for (const entry of manifest.pages as Array<unknown>) {
      if (!isRecord(entry)) {
        return 'invalid manifest shape: each pages entry must be an object';
      }
      const e = entry;
      if (typeof e.pattern !== 'string' || e.pattern === '') {
        return 'invalid manifest shape: pages entry pattern must be a string';
      }
      if (e.revalidate !== undefined && typeof e.revalidate !== 'number') {
        return 'invalid manifest shape: pages entry revalidate must be a number';
      }
    }
  }

  // pathRevalidate is the RAW per-path OBJECT config shipped alongside `pages`
  // so dispatch can resolve an inherit-eligible page (a pages entry with no
  // baked revalidate) against the real request path. Same shape as the object
  // form of `revalidate`: a map of pattern → number.
  if (manifest.pathRevalidate !== undefined) {
    if (!isRecord(manifest.pathRevalidate)) {
      return 'invalid manifest shape: pathRevalidate must be an object';
    }
    for (const [pathname, value] of Object.entries(manifest.pathRevalidate)) {
      if (typeof value !== 'number') {
        return `invalid manifest shape: pathRevalidate.${pathname} must be a number`;
      }
    }
  }

  // fallbackRules fire after the static asset resolver 404s. Rewrites only,
  // so every entry carries the same internal-destination constraints as a
  // status=200 redirectRule.
  if (manifest.fallbackRules !== undefined) {
    if (!Array.isArray(manifest.fallbackRules)) {
      return 'invalid manifest shape: fallbackRules must be an array';
    }
    if (manifest.fallbackRules.length > MAX_ROUTING_RULES) {
      return `invalid manifest shape: fallbackRules has ${manifest.fallbackRules.length} entries, exceeds the ${MAX_ROUTING_RULES} per-list limit`;
    }
    for (const rule of manifest.fallbackRules) {
      if (!isRecord(rule)) {
        return 'invalid manifest shape: fallbackRules entries must be objects';
      }
      const ruleObject = rule;
      if (
        typeof ruleObject.source !== 'string' ||
        typeof ruleObject.destination !== 'string' ||
        typeof ruleObject.status !== 'number'
      ) {
        return 'invalid manifest shape: fallbackRules entries must have string source, string destination, and numeric status';
      }
      const sourceRef = JSON.stringify(ruleObject.source as string);
      if (ruleObject.status !== 200) {
        return `invalid manifest shape: fallbackRules entry ${sourceRef} status must be 200 (fallbacks are rewrites only)`;
      }
      const destination = ruleObject.destination as string;
      if (destination.includes('?')) {
        return `invalid manifest shape: fallbackRules entry ${sourceRef} destination must not contain a query string`;
      }
      if (!destination.startsWith('/')) {
        return `invalid manifest shape: fallbackRules entry ${sourceRef} destination must be path-absolute (start with "/")`;
      }
      if (destination.startsWith('//')) {
        return `invalid manifest shape: fallbackRules entry ${sourceRef} destination must not start with "//" (protocol-relative URLs parse cross-origin; use a single-slash path-absolute destination)`;
      }
      const hostError = validateRuleHost(ruleObject, 'fallbackRules', sourceRef);
      if (hostError) {
        return hostError;
      }
    }
  }

  if (manifest.websocket !== undefined) {
    if (!isRecord(manifest.websocket)) {
      return 'invalid manifest shape: websocket must be an object';
    }
    const websocket = manifest.websocket;
    if (!Array.isArray(websocket.routes)) {
      return 'invalid manifest shape: websocket.routes must be an array';
    }
    for (const route of websocket.routes) {
      if (!isRecord(route)) {
        return 'invalid manifest shape: websocket.routes entries must be objects';
      }
      const routeObject = route;
      if (typeof routeObject.className !== 'string') {
        return 'invalid manifest shape: websocket.routes entries must have a string className';
      }
      if (routeObject.bindingName !== undefined && typeof routeObject.bindingName !== 'string') {
        return 'invalid manifest shape: websocket.routes entry bindingName must be a string';
      }
    }
    if (
      !Array.isArray(websocket.classes) ||
      !websocket.classes.every((x) => typeof x === 'string')
    ) {
      return 'invalid manifest shape: websocket.classes must be an array of strings';
    }
    if (websocket.migrations !== undefined) {
      if (!Array.isArray(websocket.migrations)) {
        return 'invalid manifest shape: websocket.migrations must be an array';
      }
      for (const migration of websocket.migrations) {
        if (!isRecord(migration)) {
          return 'invalid manifest shape: websocket.migrations entries must be objects';
        }
        const migrationObject = migration;
        if (typeof migrationObject.tag !== 'string' || migrationObject.tag.length === 0) {
          return 'invalid manifest shape: websocket.migrations entries must have a non-empty string tag';
        }
        for (const field of ['newClasses', 'newSqliteClasses', 'deletedClasses'] as const) {
          const value = migrationObject[field];
          if (
            value !== undefined &&
            (!Array.isArray(value) || !value.every((className) => typeof className === 'string'))
          ) {
            return `invalid manifest shape: websocket.migrations ${field} must be an array of strings`;
          }
        }
      }
    }
  }

  if (manifest.sandbox !== undefined) {
    // sandbox is meaningless without a user worker. Static/SPA deploys are
    // served straight from KV/R2 by dispatch — no script is created, so a
    // `sandbox` block can't be wired to anything. Reject up-front rather
    // than silently dropping the block; a stale manifest carrying `sandbox`
    // after the project type flips would otherwise surface as a confusing
    // runtime no-op rather than a clear deploy-time error.
    if (manifest.type === 'static' || manifest.type === 'spa') {
      return 'sandbox is not supported for static/spa deployments';
    }
    if (!isRecord(manifest.sandbox)) {
      return 'invalid manifest shape: sandbox must be an object';
    }
    const sandbox = manifest.sandbox;
    for (const key of ['bindingName', 'className', 'containerName', 'image']) {
      if (typeof sandbox[key] !== 'string' || sandbox[key].length === 0) {
        return `invalid manifest shape: sandbox.${key} must be a non-empty string`;
      }
    }
    if (isLocalImageReference(sandbox.image as string)) {
      return 'invalid manifest shape: sandbox.image must be a registry image reference';
    }
    if (sandbox.instanceType !== undefined && typeof sandbox.instanceType !== 'string') {
      return 'invalid manifest shape: sandbox.instanceType must be a string';
    }
    if (
      sandbox.maxInstances !== undefined &&
      (typeof sandbox.maxInstances !== 'number' ||
        !Number.isInteger(sandbox.maxInstances) ||
        sandbox.maxInstances < 1)
    ) {
      return 'invalid manifest shape: sandbox.maxInstances must be a positive integer';
    }
    if (sandbox.migrations !== undefined) {
      if (!Array.isArray(sandbox.migrations)) {
        return 'invalid manifest shape: sandbox.migrations must be an array';
      }
      for (const migration of sandbox.migrations) {
        if (!isRecord(migration)) {
          return 'invalid manifest shape: sandbox.migrations entries must be objects';
        }
        const migrationObject = migration;
        if (typeof migrationObject.tag !== 'string') {
          return 'invalid manifest shape: sandbox.migrations entries must have a string tag';
        }
        if (
          migrationObject.newSqliteClasses !== undefined &&
          (!Array.isArray(migrationObject.newSqliteClasses) ||
            !migrationObject.newSqliteClasses.every((value) => typeof value === 'string'))
        ) {
          return 'invalid manifest shape: sandbox.migrations newSqliteClasses must be an array of strings';
        }
        if (
          migrationObject.deletedClasses !== undefined &&
          (!Array.isArray(migrationObject.deletedClasses) ||
            !migrationObject.deletedClasses.every((value) => typeof value === 'string'))
        ) {
          return 'invalid manifest shape: sandbox.migrations deletedClasses must be an array of strings';
        }
      }
    }
  }

  if (manifest.live !== undefined) {
    if (!isRecord(manifest.live)) {
      return 'invalid manifest shape: live must be an object';
    }
    const live = manifest.live;
    for (const key of ['bindingName', 'className']) {
      if (typeof live[key] !== 'string' || live[key].length === 0) {
        return `invalid manifest shape: live.${key} must be a non-empty string`;
      }
    }
    if (live.storage !== 'sqlite') {
      return 'invalid manifest shape: live.storage must be "sqlite"';
    }
    if (!Array.isArray(live.classes) || !live.classes.every((x) => typeof x === 'string')) {
      return 'invalid manifest shape: live.classes must be an array of strings';
    }
    if (live.migrations !== undefined) {
      if (!Array.isArray(live.migrations)) {
        return 'invalid manifest shape: live.migrations must be an array';
      }
      for (const migration of live.migrations) {
        if (!isRecord(migration)) {
          return 'invalid manifest shape: live.migrations entries must be objects';
        }
        const migrationObject = migration;
        if (typeof migrationObject.tag !== 'string') {
          return 'invalid manifest shape: live.migrations entries must have a string tag';
        }
        if (
          migrationObject.newSqliteClasses !== undefined &&
          (!Array.isArray(migrationObject.newSqliteClasses) ||
            !migrationObject.newSqliteClasses.every((value) => typeof value === 'string'))
        ) {
          return 'invalid manifest shape: live.migrations newSqliteClasses must be an array of strings';
        }
      }
    }
  }

  return null;
}

function isLocalImageReference(image: string): boolean {
  return (
    image.startsWith('.') || image.startsWith('/') || image.toLowerCase().includes('dockerfile')
  );
}
