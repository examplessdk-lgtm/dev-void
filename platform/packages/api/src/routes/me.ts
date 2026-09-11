import { Hono } from 'hono';
import type { ApiEnv } from '../env.ts';
import { getPlanLimits } from '../tiers.ts';

const app = new Hono<ApiEnv>()

  .get('/', async (context) => {
    const user = context.get('user');
    const limits = getPlanLimits(user.plan);
    return context.json({
      id: user.id,
      login: user.login,
      email: user.email,
      provider: user.provider,
      plan: user.plan,
      role: user.role,
      billing_cycle_start: user.billing_cycle_start,
      limits,
    });
  });

export default app;
