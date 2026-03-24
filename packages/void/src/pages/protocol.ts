import { ValidationError } from "./validation-error";
import { DEFERRED, separateDeferred, type ResolvedDeferredGroup } from "./defer";
import { resolveHead, type HeadDescriptor, type HeadConfig } from "./head";

export { ValidationError };

const POWERED_BY = { "X-Powered-By": "Void" } as const;

export interface PageObject {
  component: string;
  props: Record<string, unknown>;
  shared: Record<string, unknown>;
  url: string;
  errors: Record<string, string> | null;
  head?: HeadDescriptor;
  deferred?: string[];
  deferredKeys?: Record<string, string>;
}

function isPagesRequest(c: any): boolean {
  return c.req.header("x-voidpages") === "true";
}

function pageJsonResponse(pageObj: PageObject): Response {
  return Response.json(pageObj, {
    headers: { "X-VoidPages": "true", Vary: "X-VoidPages", ...POWERED_BY },
  });
}

/** Extract props from a handler result, handling Response wrapping from withValidator */
async function extractProps(result: unknown): Promise<Record<string, unknown>> {
  if (result instanceof Response) {
    const ct = result.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      return (await result.json()) as Record<string, unknown>;
    }
    return {};
  }
  return (result as Record<string, unknown>) ?? {};
}

/** Flatten withValidator's { issues: [{ slot, issues: [{ message, path }] }] } into { field: message } */
export function flattenValidationErrors(body: any): Record<string, string> {
  const errors: Record<string, string> = {};
  if (body?.issues) {
    for (const slotIssue of body.issues) {
      for (const issue of slotIssue.issues) {
        // path is a dot-joined string from flattenIssues (e.g. "name", "address.city")
        const key = typeof issue.path === "string" ? issue.path : slotIssue.slot;
        if (typeof key === "string") errors[key] = issue.message;
      }
    }
  }
  return errors;
}

/** Strip deferred sentinels from props, setting their keys to null. Used by mutations. */
function stripDeferred(props: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value && typeof value === "object" && DEFERRED in value) {
      result[key] = null;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Build a streaming response that sends an initial chunk then streams deferred results. */
function streamDeferredResponse(
  initialChunk: string,
  deferredMap: Record<string, ResolvedDeferredGroup>,
  c: any,
  contentType: string,
  formatResolved: (group: string, data: unknown) => string,
  formatRejected: (group: string, error: string) => string,
): Response {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  writer.write(encoder.encode(initialChunk));

  const entries = Object.entries(deferredMap);
  let remaining = entries.length;

  for (const [group, { resolver }] of entries) {
    resolver(c)
      .then((data) => writer.write(encoder.encode(formatResolved(group, data))))
      .catch((err: unknown) =>
        writer.write(
          encoder.encode(formatRejected(group, err instanceof Error ? err.message : String(err))),
        ),
      )
      .finally(() => {
        if (--remaining === 0) writer.close();
      });
  }

  return new Response(readable, {
    headers: { "content-type": contentType, ...POWERED_BY },
  });
}

/** Handle GET page request — run handler, return page object or SSR HTML */
export async function handlePageGet(
  handler: Function | undefined,
  headFn: ((c: any, props: Record<string, unknown>) => HeadDescriptor | undefined) | undefined,
  c: any,
  componentId: string,
  renderFn: (
    pageObj: PageObject,
    assetTags: { css: string; preloads: string; body: string },
  ) => Promise<string>,
  getAssetTags: (
    req: Request,
    env: any,
    componentId: string,
  ) => Promise<{ css: string; preloads: string; body: string }>,
  configHead?: HeadConfig,
  island?: boolean,
): Promise<Response> {
  const shared = c.get("shared") || {};

  // Run loader and check for redirect/error responses before extracting props
  let props: Record<string, unknown> = {};
  if (handler) {
    const result = await handler(c);
    if (result instanceof Response) {
      const status = result.status;
      if (status >= 300) return result;
    }
    props = await extractProps(result);
  }

  // Resolve head metadata
  const pageHead = headFn ? headFn(c, props) : undefined;
  const middlewareHead = c.get("headDefaults") as HeadDescriptor | undefined;
  const head = resolveHead(configHead, middlewareHead, pageHead);

  // Separate immediate props from deferred sentinels
  const { immediateProps, deferredMap } = separateDeferred(props);
  const hasDeferred = Object.keys(deferredMap).length > 0;

  // Build key-to-group mapping for the client
  const deferredKeys: Record<string, string> = {};
  if (hasDeferred) {
    for (const [group, { keys }] of Object.entries(deferredMap)) {
      for (const key of keys) {
        deferredKeys[key] = group;
      }
    }
  }

  const pageObj: PageObject = {
    component: componentId,
    props: immediateProps,
    shared,
    url: c.req.path,
    errors: null,
    ...(head && { head }),
    ...(hasDeferred && {
      deferred: Object.keys(deferredMap),
      deferredKeys,
    }),
  };

  // Island pages always render HTML — no Inertia JSON navigation
  if (!island && isPagesRequest(c)) {
    // Prefetch requests: resolve all deferred props inline (plain JSON, no streaming)
    const isPrefetch = c.req.header("purpose") === "prefetch";
    if (isPrefetch && hasDeferred) {
      const resolvedProps: Record<string, unknown> = { ...immediateProps };
      await Promise.all(
        Object.entries(deferredMap).map(async ([, { resolver, keys }]) => {
          try {
            const data = await resolver(c);
            if (keys.length === 1) {
              resolvedProps[keys[0]] = data;
            } else {
              const obj = data as Record<string, unknown>;
              for (const key of keys) {
                resolvedProps[key] = obj[key];
              }
            }
          } catch {
            for (const key of keys) {
              resolvedProps[key] = null;
            }
          }
        }),
      );
      return pageJsonResponse({
        ...pageObj,
        props: resolvedProps,
        deferred: undefined,
      });
    }

    if (!hasDeferred) {
      return pageJsonResponse(pageObj);
    }
    // Stream NDJSON: first line is PageObject, subsequent lines are deferred groups
    return streamDeferredResponse(
      JSON.stringify(pageObj) + "\n",
      deferredMap,
      c,
      "application/x-ndjson",
      (group, data) => JSON.stringify({ __deferred: group, data }) + "\n",
      (group, error) => JSON.stringify({ __deferred: group, error }) + "\n",
    );
  }

  const assetTags = await getAssetTags(c.req.raw, c.env, componentId);
  const html = await renderFn(pageObj, assetTags);

  if (!hasDeferred) {
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        ...POWERED_BY,
      },
    });
  }

  // Stream HTML followed by deferred <script> tags
  return streamDeferredResponse(
    html,
    deferredMap,
    c,
    "text/html; charset=utf-8",
    (group, data) =>
      `\n<script>window.__resolveDeferred?window.__resolveDeferred(${JSON.stringify(group)},${JSON.stringify(data)}):(window.__deferredQueue??=[]).push([${JSON.stringify(group)},${JSON.stringify(data)}])</script>`,
    (group, error) =>
      `\n<script>window.__rejectDeferred?window.__rejectDeferred(${JSON.stringify(group)},${JSON.stringify(error)}):(window.__deferredQueue??=[]).push([${JSON.stringify(group)},0,${JSON.stringify(error)}])</script>`,
  );
}

/** Handle POST/PUT/DELETE page request — run mutation, then re-run GET or redirect */
export async function handlePageMutation(
  mutationHandler: Function | undefined,
  getHandler: Function | undefined,
  headFn: ((c: any, props: Record<string, unknown>) => HeadDescriptor | undefined) | undefined,
  c: any,
  componentId: string,
  renderFn: (
    pageObj: PageObject,
    assetTags: { css: string; preloads: string; body: string },
  ) => Promise<string>,
  getAssetTags: (
    req: Request,
    env: any,
    componentId: string,
  ) => Promise<{ css: string; preloads: string; body: string }>,
  configHead?: HeadConfig,
  island?: boolean,
): Promise<Response> {
  const shared = c.get("shared") || {};
  const middlewareHead = c.get("headDefaults") as HeadDescriptor | undefined;

  function buildMutationPageObj(
    props: Record<string, unknown>,
    errors: Record<string, string> | null,
  ): PageObject {
    const pageHead = headFn ? headFn(c, props) : undefined;
    const head = resolveHead(configHead, middlewareHead, pageHead);
    return {
      component: componentId,
      props,
      shared,
      url: c.req.path,
      errors,
      ...(head && { head }),
    };
  }

  let result: unknown;
  try {
    result = mutationHandler ? await mutationHandler(c) : undefined;
  } catch (e) {
    if (e instanceof ValidationError) {
      if (island) {
        return Response.json({ errors: e.errors }, { status: 422 });
      }
      const rawProps = getHandler ? await extractProps(await getHandler(c)) : {};
      const props = stripDeferred(rawProps);
      const pageObj = buildMutationPageObj(props, e.errors);
      if (isPagesRequest(c)) return pageJsonResponse(pageObj);
      const assetTags = await getAssetTags(c.req.raw, c.env, componentId);
      return new Response(await renderFn(pageObj, assetTags), {
        headers: { "content-type": "text/html; charset=utf-8", ...POWERED_BY },
      });
    }
    throw e;
  }

  // Handle Response results (from withValidator or explicit redirect)
  if (result instanceof Response) {
    const status = result.status;
    // Redirect
    if (status >= 300 && status < 400) return result;
    // withValidator 400
    if (status === 400) {
      const body = await result.json();
      const errors = flattenValidationErrors(body);
      if (island) {
        return Response.json({ errors }, { status: 422 });
      }
      const rawProps = getHandler ? await extractProps(await getHandler(c)) : {};
      const props = stripDeferred(rawProps);
      const pageObj = buildMutationPageObj(props, errors);
      if (isPagesRequest(c)) return pageJsonResponse(pageObj);
      const assetTags = await getAssetTags(c.req.raw, c.env, componentId);
      return new Response(await renderFn(pageObj, assetTags), {
        headers: { "content-type": "text/html; charset=utf-8", ...POWERED_BY },
      });
    }
    // 204 (void from withValidator) — fall through to re-run GET
    if (status !== 204) return result;
  }

  // void — re-run GET with fresh props
  if (island) {
    return Response.json({ success: true });
  }
  const rawProps = getHandler ? await extractProps(await getHandler(c)) : {};
  const props = stripDeferred(rawProps);
  const pageObj = buildMutationPageObj(props, null);
  if (isPagesRequest(c)) return pageJsonResponse(pageObj);
  const assetTags = await getAssetTags(c.req.raw, c.env, componentId);
  return new Response(await renderFn(pageObj, assetTags), {
    headers: { "content-type": "text/html; charset=utf-8", ...POWERED_BY },
  });
}
