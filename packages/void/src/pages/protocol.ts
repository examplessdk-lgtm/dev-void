import type { CloudBindings, CloudContext } from '../runtime/handler';
import { isConvertedResponse } from '../runtime/response';
import { DEFERRED, separateDeferred, type ResolvedDeferredGroup } from './defer';
import { resolveHead, type HeadDescriptor, type HeadConfig } from './head';
import { ValidationError } from './validation-error';

export { ValidationError };

const POWERED_BY = { 'X-Powered-By': 'Void' } as const;

/** Escape characters that are unsafe inside inline <script> tags to prevent XSS. */
export function safeJsonStringify(value: unknown): string {
  const json = JSON.stringify(value) ?? 'null';
  return json
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

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

export type PageRenderResult = string | ReadableStream<Uint8Array>;

interface ValidationIssue {
  message?: string;
  path?: string;
}

interface ValidationSlotIssue {
  slot?: string;
  issues?: ValidationIssue[];
}

interface ValidationErrorBody {
  issues?: ValidationSlotIssue[];
}

type PageHandler = ((c: CloudContext) => unknown | Promise<unknown>) | undefined;
type PageHeadHandler =
  | ((c: CloudContext, props: Record<string, unknown>) => HeadDescriptor | undefined)
  | undefined;
type AssetTags = { css: string; preloads: string; body: string };
type RenderPage = (pageObj: PageObject, assetTags: AssetTags) => Promise<PageRenderResult>;
type GetAssetTags = (req: Request, env: CloudBindings, componentId: string) => Promise<AssetTags>;

function isPagesRequest(c: CloudContext): boolean {
  return c.req.header('x-voidpages') === 'true';
}

function pageJsonResponse(pageObj: PageObject): Response {
  return Response.json(pageObj, {
    headers: { 'X-VoidPages': 'true', Vary: 'X-VoidPages', ...POWERED_BY },
  });
}

function requestPathWithSearch(c: CloudContext): string {
  return c.req.path + new URL(c.req.url).search;
}

/** Extract props from a handler result, handling Response wrapping from withValidator */
async function extractProps(result: unknown): Promise<Record<string, unknown>> {
  if (result instanceof Response) {
    const ct = result.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      return (await result.json()) as Record<string, unknown>;
    }
    return {};
  }
  return (result as Record<string, unknown>) ?? {};
}

/** Flatten withValidator's { issues: [{ slot, issues: [{ message, path }] }] } into { field: message } */
export function flattenValidationErrors(body: unknown): Record<string, string> {
  const errors: Record<string, string> = {};
  const issues = (body as ValidationErrorBody | null)?.issues;
  if (issues) {
    for (const slotIssue of issues) {
      for (const issue of slotIssue.issues ?? []) {
        // path is a dot-joined string from flattenIssues (e.g. "name", "address.city")
        const key = typeof issue.path === 'string' ? issue.path : slotIssue.slot;
        if (typeof key === 'string') {
          errors[key] = issue.message ?? 'Invalid value';
        }
      }
    }
  }
  return errors;
}

/** Strip deferred sentinels from props, setting their keys to null. Used by mutations. */
function stripDeferred(props: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value && typeof value === 'object' && DEFERRED in value) {
      result[key] = null;
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function writeRenderResult(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  result: PageRenderResult,
): Promise<void> {
  if (typeof result === 'string') {
    await writer.write(encoder.encode(result));
    return;
  }

  const reader = result.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }
    await writer.write(value);
  }
}

function renderedResponse(result: PageRenderResult, contentType: string): Response {
  return new Response(result, {
    headers: {
      'content-type': contentType,
      ...POWERED_BY,
    },
  });
}

/** Build a streaming response that sends an initial chunk then streams deferred results. */
function streamDeferredResponse(
  initialChunk: PageRenderResult,
  deferredMap: Record<string, ResolvedDeferredGroup>,
  c: CloudContext,
  contentType: string,
  formatResolved: (group: string, data: unknown) => string,
  formatRejected: (group: string, error: string) => string,
): Response {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  const entries = Object.entries(deferredMap);
  const pendingChunks = entries.map(([group, { resolver }]) =>
    resolver(c)
      .then((data) => formatResolved(group, data))
      .catch((err: unknown) =>
        formatRejected(group, err instanceof Error ? err.message : String(err)),
      ),
  );

  (async () => {
    await writeRenderResult(writer, encoder, initialChunk);
    await Promise.all(
      pendingChunks.map(async (chunk) => writer.write(encoder.encode(await chunk))),
    );
    await writer.close();
  })().catch((error: unknown) => {
    writer.abort(error).catch(() => {});
  });

  return new Response(readable, {
    headers: { 'content-type': contentType, ...POWERED_BY },
  });
}

/** Handle GET page request — run handler, return page object or SSR HTML */
export async function handlePageGet(
  handler: PageHandler,
  headFn: PageHeadHandler,
  c: CloudContext,
  componentId: string,
  renderFn: RenderPage,
  getAssetTags: GetAssetTags,
  configHead?: HeadConfig,
  island?: boolean,
): Promise<Response> {
  const shared = (c.get('shared') as Record<string, unknown> | undefined) ?? {};

  // Run loader and check for redirect/error responses before extracting props
  let props: Record<string, unknown> = {};
  if (handler) {
    const result = await handler(c);
    // Responses from convertReturnValue (withValidator/middleware paths) always
    // flow through to extractProps — they wrap plain return values (objects as
    // 200 JSON, null/undefined as 204, strings as text/html) and must be
    // unwrapped as page props.
    //
    // User-returned Responses: pass through errors/redirects (>= 300) and
    // non-JSON 200s (file downloads, streams). JSON 200s are still extracted
    // as props for backward compat with loaders using c.json().
    if (result instanceof Response && !isConvertedResponse(result)) {
      const ct = result.headers.get('content-type') || '';
      if (result.status >= 300 || !ct.includes('application/json')) {
        return result;
      }
    }
    props = await extractProps(result);
  }

  // Resolve head metadata
  const pageHead = headFn ? headFn(c, props) : undefined;
  const middlewareHead = c.get('headDefaults') as HeadDescriptor | undefined;
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
    url: requestPathWithSearch(c),
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
    const isPrefetch = c.req.header('purpose') === 'prefetch';
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
      JSON.stringify(pageObj) + '\n',
      deferredMap,
      c,
      'application/x-ndjson',
      (group, data) => JSON.stringify({ __deferred: group, data }) + '\n',
      (group, error) => JSON.stringify({ __deferred: group, error }) + '\n',
    );
  }

  const assetTags = await getAssetTags(c.req.raw, c.env, componentId);
  const html = await renderFn(pageObj, assetTags);

  if (!hasDeferred) {
    return renderedResponse(html, 'text/html; charset=utf-8');
  }

  // Stream HTML followed by deferred <script> tags
  return streamDeferredResponse(
    html,
    deferredMap,
    c,
    'text/html; charset=utf-8',
    (group, data) =>
      `\n<script>window.__resolveDeferred?window.__resolveDeferred(${safeJsonStringify(group)},${safeJsonStringify(data)}):(window.__deferredQueue??=[]).push([${safeJsonStringify(group)},${safeJsonStringify(data)}])</script>`,
    (group, error) =>
      `\n<script>window.__rejectDeferred?window.__rejectDeferred(${safeJsonStringify(group)},${safeJsonStringify(error)}):(window.__deferredQueue??=[]).push([${safeJsonStringify(group)},0,${safeJsonStringify(error)}])</script>`,
  );
}

/** Handle POST/PUT/DELETE page request — run mutation, then re-run GET or redirect */
export async function handlePageMutation(
  mutationHandler: PageHandler,
  getHandler: PageHandler,
  headFn: PageHeadHandler,
  c: CloudContext,
  componentId: string,
  renderFn: RenderPage,
  getAssetTags: GetAssetTags,
  configHead?: HeadConfig,
  island?: boolean,
): Promise<Response> {
  const shared = (c.get('shared') as Record<string, unknown> | undefined) ?? {};
  const middlewareHead = c.get('headDefaults') as HeadDescriptor | undefined;

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
      url: requestPathWithSearch(c),
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
      if (isPagesRequest(c)) {
        return pageJsonResponse(pageObj);
      }
      const assetTags = await getAssetTags(c.req.raw, c.env, componentId);
      return renderedResponse(await renderFn(pageObj, assetTags), 'text/html; charset=utf-8');
    }
    throw e;
  }

  // Handle Response results (from withValidator or explicit redirect)
  if (result instanceof Response) {
    const status = result.status;
    // Redirect
    if (status >= 300 && status < 400) {
      return result;
    }
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
      if (isPagesRequest(c)) {
        return pageJsonResponse(pageObj);
      }
      const assetTags = await getAssetTags(c.req.raw, c.env, componentId);
      return renderedResponse(await renderFn(pageObj, assetTags), 'text/html; charset=utf-8');
    }
    // 204 (void from withValidator) — fall through to re-run GET
    if (status !== 204) {
      return result;
    }
  }

  // void — re-run GET with fresh props
  if (island) {
    return Response.json({ success: true });
  }
  const rawProps = getHandler ? await extractProps(await getHandler(c)) : {};
  const props = stripDeferred(rawProps);
  const pageObj = buildMutationPageObj(props, null);
  if (isPagesRequest(c)) {
    return pageJsonResponse(pageObj);
  }
  const assetTags = await getAssetTags(c.req.raw, c.env, componentId);
  return renderedResponse(await renderFn(pageObj, assetTags), 'text/html; charset=utf-8');
}
