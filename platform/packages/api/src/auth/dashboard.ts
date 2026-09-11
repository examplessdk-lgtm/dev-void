import { verifyJwt } from './jwt.ts';

export type DashboardSession = Readonly<{
  token: string;
  user: {
    id: string;
    login: string;
  };
}>;

export async function authenticateDashboardToken(
  token: string | undefined,
  jwtSecret: string | undefined,
): Promise<DashboardSession | null> {
  if (!token || !jwtSecret) {
    return null;
  }

  const payload = await verifyJwt(token, jwtSecret, 'api');
  if (!payload?.sub || !payload.login) {
    return null;
  }

  return {
    token,
    user: {
      id: payload.sub,
      login: payload.login,
    },
  };
}
