import { Hono } from 'hono';
import { getAllowlistEntryStatuses } from '../../db.ts';
import type { ApiEnv } from '../../env.ts';
import { getAllowlist, putAllowlist } from '../../signup-allowlist.ts';
import { SignupControlPage } from '../views/signup-control.tsx';

const app = new Hono<ApiEnv>();

function parseAllowlistPatterns(input: string): ReadonlyArray<string> {
  return Array.from(
    new Set(
      input
        .split(/[\s,]+/)
        .map((pattern) => pattern.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

// GET /signup-control
app.get('/', async (context) => {
  const db = context.get('db');
  const enabled = (await context.env.ROUTING.get('signup:enabled')) === 'true';
  const entries = await getAllowlist(context.env.ROUTING);
  const entryStatuses = await getAllowlistEntryStatuses(db, entries);
  return context.html(
    <SignupControlPage
      enabled={enabled}
      entries={entryStatuses}
      username={context.get('user').login}
    />,
  );
});

// POST /signup-control/toggle
app.post('/toggle', async (context) => {
  const current = (await context.env.ROUTING.get('signup:enabled')) === 'true';
  await context.env.ROUTING.put('signup:enabled', String(!current));
  return context.redirect('/admin/signup-control');
});

// POST /signup-control/add
app.post('/add', async (context) => {
  const body = await context.req.parseBody();
  const type = body.type as string;
  const patterns = parseAllowlistPatterns((body.pattern as string) ?? '');
  const note = ((body.note as string) || '').trim();

  if (patterns.length === 0 || (type !== 'github' && type !== 'email')) {
    return context.html('<h1>Invalid entry</h1>', 400);
  }

  const entries = await getAllowlist(context.env.ROUTING);
  for (const pattern of patterns) {
    entries.push({ type: type as 'github' | 'email', pattern, note: note || undefined });
  }
  await putAllowlist(context.env.ROUTING, entries);
  return context.redirect('/admin/signup-control');
});

// POST /signup-control/delete
app.post('/delete', async (context) => {
  const body = await context.req.parseBody();
  const index = parseInt(body.index as string, 10);
  const entries = await getAllowlist(context.env.ROUTING);

  if (isNaN(index) || index < 0 || index >= entries.length) {
    return context.html('<h1>Invalid index</h1>', 400);
  }

  entries.splice(index, 1);
  await putAllowlist(context.env.ROUTING, entries);
  return context.redirect('/admin/signup-control');
});

export default app;
