import type {
  ActionUrl,
  ResolveActionBody,
  ResolveActionParams,
  HasActionParams,
} from 'void/routes';

type ActionOptions<U extends string> =
  HasActionParams<U> extends true ? { params: ResolveActionParams<U> } : { params?: never };

let _router: any = null;

/** Called during app initialization to store the router instance */
export function setActionRouter(router: any): void {
  _router = router;
}

/** Programmatic one-shot page action call with Inertia page update */
export async function action<U extends ActionUrl & string>(
  url: U,
  ...args: HasActionParams<U> extends true
    ? [data?: ResolveActionBody<U>, options?: ActionOptions<U>]
    : [data?: ResolveActionBody<U>]
): Promise<void> {
  if (!_router) {
    throw new Error('action() called before router initialized');
  }

  const data = args[0];
  const options = args[1] as ActionOptions<U> | undefined;

  let resolvedUrl: string = url;
  let actionQuery = '';

  const qIdx = resolvedUrl.indexOf('?');
  if (qIdx !== -1) {
    actionQuery = resolvedUrl.slice(qIdx);
    resolvedUrl = resolvedUrl.slice(0, qIdx);
  }

  if ((options as any)?.params) {
    for (const [key, value] of Object.entries((options as any).params)) {
      resolvedUrl = resolvedUrl.replace(`:${key}`, encodeURIComponent(value as string));
    }
  }

  resolvedUrl = resolvedUrl + actionQuery;
  await _router.visit(resolvedUrl, { method: 'POST', data });
}
