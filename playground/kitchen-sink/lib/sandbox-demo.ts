export interface EdgeRequestSample {
  path: string;
  colo: string;
  status: number;
  durationMs: number;
  cache: 'hit' | 'miss' | 'bypass';
  botScore: number;
}

export const sampleRequests: Array<EdgeRequestSample> = [
  { path: '/', colo: 'SJC', status: 200, durationMs: 31, cache: 'hit', botScore: 92 },
  { path: '/docs', colo: 'LHR', status: 200, durationMs: 84, cache: 'hit', botScore: 88 },
  { path: '/api/search', colo: 'SJC', status: 200, durationMs: 142, cache: 'miss', botScore: 74 },
  { path: '/api/search', colo: 'AMS', status: 503, durationMs: 812, cache: 'bypass', botScore: 63 },
  { path: '/login', colo: 'IAD', status: 401, durationMs: 96, cache: 'bypass', botScore: 41 },
  { path: '/api/profile', colo: 'NRT', status: 200, durationMs: 205, cache: 'miss', botScore: 67 },
  { path: '/assets/app.css', colo: 'SJC', status: 200, durationMs: 12, cache: 'hit', botScore: 99 },
  {
    path: '/api/checkout',
    colo: 'FRA',
    status: 500,
    durationMs: 477,
    cache: 'bypass',
    botScore: 58,
  },
  { path: '/pricing', colo: 'LHR', status: 200, durationMs: 57, cache: 'hit', botScore: 91 },
  { path: '/api/checkout', colo: 'FRA', status: 200, durationMs: 238, cache: 'miss', botScore: 55 },
];

export const defaultSandboxCode = `export default function analyze(requests) {
  const byColo = requests.reduce((groups, request) => {
    groups[request.colo] ??= [];
    groups[request.colo].push(request);
    return groups;
  }, {});
  const slowest = [...requests].sort((a, b) => b.durationMs - a.durationMs).slice(0, 3);
  const failures = requests.filter((request) => request.status >= 500);
  const cacheHits = requests.filter((request) => request.cache === "hit").length;

  return {
    summary: {
      requests: requests.length,
      cacheHitRate: Number((cacheHits / requests.length).toFixed(2)),
      failureRate: Number((failures.length / requests.length).toFixed(2)),
    },
    slowest,
    coloLatency: Object.fromEntries(
      Object.entries(byColo).map(([colo, rows]) => [
        colo,
        Math.round(rows.reduce((sum, row) => sum + row.durationMs, 0) / rows.length),
      ]),
    ),
    nextAction:
      failures.length > 0
        ? "Investigate origin errors before scaling traffic."
        : "No server errors in this sample.",
  };
}
`;
