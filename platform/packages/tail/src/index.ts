type Env = Readonly<{
  ANALYTICS: AnalyticsEngineDataset;
  PLATFORM_DISPATCH_WORKER_NAME?: string;
}>;

function isFetchEvent(event: TraceItem['event']): event is TraceItemFetchEventInfo {
  return event !== null && 'request' in event;
}

/**
 * Parse versioned or legacy worker script names.
 * Versioned: "user-{slug}-dpl_{id}" → projectKey "user-{slug}", deployId "dpl_{id}"
 * Legacy: "user-{slug}" → projectKey "user-{slug}", deployId ""
 * Platform dispatch: "void-dispatch" / "void-dispatch-staging" →
 *   projectKey "__platform-dispatch" / "__platform-dispatch-staging"
 *   (reserved prefix so admin tooling can surface relay errors without
 *   colliding with any user-* key).
 */
export function parseScriptName(
  scriptName: string,
  platformDispatchWorkerName?: string,
): { projectKey: string; deployId: string } | null {
  const dplIndex = scriptName.lastIndexOf('-dpl_');
  if (dplIndex > 4) {
    return {
      projectKey: scriptName.slice(0, dplIndex),
      deployId: scriptName.slice(dplIndex + 1),
    };
  }
  if (scriptName.startsWith('user-')) {
    return { projectKey: scriptName, deployId: '' };
  }
  if (platformDispatchWorkerName && scriptName === platformDispatchWorkerName) {
    return { projectKey: '__platform-dispatch', deployId: '' };
  }
  if (scriptName === 'void-dispatch' || scriptName === 'void-dispatch-staging') {
    return { projectKey: `__platform-${scriptName.slice('void-'.length)}`, deployId: '' };
  }
  return null;
}

function isDispatchKey(projectKey: string): boolean {
  return projectKey.startsWith('__platform-');
}

export default {
  async tail(events: ReadonlyArray<TraceItem>, env: Env) {
    const items = events.flatMap((event) => {
      const parsed = event.scriptName
        ? parseScriptName(event.scriptName, env.PLATFORM_DISPATCH_WORKER_NAME)
        : null;
      return parsed ? [{ event, parsed }] : [];
    });
    // A batch from the dispatch Worker's consumer holds the dispatcher item
    // plus the user Worker items it invoked. Each user Worker also has its own
    // tail consumer, which delivers those same items, so keep only the
    // dispatcher items here to avoid writing every user log line twice.
    const fromDispatch = items.some(({ parsed }) => isDispatchKey(parsed.projectKey));

    for (const { event, parsed } of items) {
      if (fromDispatch && !isDispatchKey(parsed.projectKey)) {
        continue;
      }

      const fetchEvent = isFetchEvent(event.event) ? event.event : null;

      env.ANALYTICS.writeDataPoint({
        indexes: [parsed.projectKey],
        blobs: [
          event.outcome,
          JSON.stringify(event.logs),
          JSON.stringify(event.exceptions),
          fetchEvent?.request.url ?? '',
          fetchEvent?.request.method ?? '',
          String(fetchEvent?.response?.status ?? ''),
          parsed.deployId,
        ],
        doubles: [event.eventTimestamp ?? Date.now(), fetchEvent?.response?.status ?? 0],
      });
    }
  },
} satisfies ExportedHandler<Env>;
