import { submitAction, type ActionResult, type VoidRouter } from 'void/pages-client';
import type { ActionUrl, ResolveActionBody, ResolveActionParams } from 'void/routes';

type ActionMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

type HasParams<U extends string> = [ResolveActionParams<U>] extends [never] ? false : true;

type ActionOptions<U extends string> = {
  data?: ResolveActionBody<U>;
  method?: ActionMethod;
} & (HasParams<U> extends true ? { params: ResolveActionParams<U> } : { params?: never });

let _router: VoidRouter | null = null;

/** Called during app initialization to store the router instance */
export function setActionRouter(router: VoidRouter): void {
  _router = router;
}

/** Programmatic one-shot page action call with Inertia page update */
export async function action<U extends ActionUrl & string>(
  url: U,
  ...args: HasParams<U> extends true ? [options: ActionOptions<U>] : [options?: ActionOptions<U>]
): Promise<ActionResult> {
  if (!_router) {
    throw new Error('action(): called before router initialization.');
  }

  const options = args[0] as ActionOptions<U> | undefined;
  const data = options?.data;
  const method = options?.method || 'POST';

  let resolvedUrl: string = url;
  let actionQuery = '';

  const qIdx = resolvedUrl.indexOf('?');
  if (qIdx !== -1) {
    actionQuery = resolvedUrl.slice(qIdx);
    resolvedUrl = resolvedUrl.slice(0, qIdx);
  }

  if (options?.params) {
    for (const [key, value] of Object.entries(options.params)) {
      resolvedUrl = resolvedUrl.replace(`:${key}`, encodeURIComponent(value as string));
    }
  }

  resolvedUrl = resolvedUrl + actionQuery;
  return submitAction(_router, resolvedUrl, { method, data });
}
