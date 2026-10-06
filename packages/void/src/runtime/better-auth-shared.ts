import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import type { Context } from 'hono';
import type { VoidAuthMigrationSchema } from '../auth/drizzle.ts';
import {
  VOID_EMAIL_AUTH_PROVIDER,
  getVoidAuthProviderEnvNames,
  isVoidSocialAuthProvider,
  type VoidAuthProvider,
  type VoidSocialAuthProvider,
} from '../auth/providers.ts';
import { authContext, type AuthState, type VoidAuthConfig } from './auth.ts';

export type VoidAuthDialect = 'sqlite' | 'postgresql' | 'mysql';

export type VoidAuthRuntimeOptions = {
  dialect: VoidAuthDialect;
  providers: Array<VoidAuthProvider> | null;
  userConfig?: VoidAuthConfig;
  dev?: boolean;
};

export type VoidAuthEnv = Record<string, unknown> & {
  DB?: D1Database;
  DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString?: string };
  BETTER_AUTH_SECRET?: string;
  GITHUB_OAUTH_ID?: string;
  GITHUB_OAUTH_SECRET?: string;
  GOOGLE_OAUTH_ID?: string;
  GOOGLE_OAUTH_SECRET?: string;
};

export type ResolvedDatabase = {
  database: NonNullable<BetterAuthOptions['database']>;
  dispose(): Promise<void>;
};

type ResolveDatabase = (env: VoidAuthEnv) => Promise<ResolvedDatabase>;
type EmailPasswordOptions = NonNullable<BetterAuthOptions['emailAndPassword']>;
type PasswordOptions = NonNullable<EmailPasswordOptions['password']>;
type VoidAuthPasswordOptions = PasswordOptions & {
  hash: NonNullable<PasswordOptions['hash']>;
  verify: NonNullable<PasswordOptions['verify']>;
};

export type VoidAuthRuntimeApi = {
  resolveVoidAuthOptions(
    request: Request,
    env: VoidAuthEnv,
    runtime: VoidAuthRuntimeOptions,
    databaseOverride?: NonNullable<BetterAuthOptions['database']>,
    disposeOverride?: () => Promise<void>,
  ): Promise<{ options: BetterAuthOptions; dispose(): Promise<void> }>;
  createVoidAuth(
    request: Request,
    env: VoidAuthEnv,
    runtime: VoidAuthRuntimeOptions,
    databaseOverride?: NonNullable<BetterAuthOptions['database']>,
    disposeOverride?: () => Promise<void>,
  ): Promise<{ auth: ReturnType<typeof betterAuth>; dispose(): Promise<void> }>;
  resolveVoidAuthState(
    request: Request,
    env: VoidAuthEnv,
    runtime: VoidAuthRuntimeOptions,
    databaseOverride?: NonNullable<BetterAuthOptions['database']>,
    disposeOverride?: () => Promise<void>,
  ): Promise<AuthState | null>;
  runVoidAuthMiddleware(
    c: Context,
    next: () => Promise<void>,
    runtime: VoidAuthRuntimeOptions,
    databaseOverride?: NonNullable<BetterAuthOptions['database']>,
    disposeOverride?: () => Promise<void>,
  ): Promise<void>;
  handleVoidAuthRequest(
    c: Context,
    runtime: VoidAuthRuntimeOptions,
    databaseOverride?: NonNullable<BetterAuthOptions['database']>,
    disposeOverride?: () => Promise<void>,
  ): Promise<Response>;
  runVoidAuthMigrations(
    request: Request,
    env: VoidAuthEnv,
    runtime: VoidAuthRuntimeOptions,
    migrationSchema: VoidAuthMigrationSchema,
  ): Promise<void>;
};

function resolveSecret(env: VoidAuthEnv, dev: boolean): string {
  const explicit =
    typeof env.BETTER_AUTH_SECRET === 'string' && env.BETTER_AUTH_SECRET.length > 0
      ? env.BETTER_AUTH_SECRET
      : undefined;
  if (explicit) {
    return explicit;
  }

  if (dev) {
    return 'void-dev-better-auth-secret-1234567890';
  }

  throw new Error('auth: Missing Better Auth secret. Set BETTER_AUTH_SECRET.');
}

function readEnvString(env: VoidAuthEnv, ...keys: Array<string>): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/** Local development uses `DATABASE_URL`; production uses the Hyperdrive binding. */
export function resolveConnectionString(
  env: VoidAuthEnv,
  database: 'PostgreSQL' | 'MySQL',
): string {
  const hyperdrive = env.HYPERDRIVE?.connectionString;
  const connectionString =
    readEnvString(env, 'DATABASE_URL') ??
    (typeof hyperdrive === 'string' && hyperdrive.length > 0 ? hyperdrive : undefined);
  if (!connectionString) {
    throw new Error(
      `auth: Better Auth requires DATABASE_URL for local ${database} dev or HYPERDRIVE in production.`,
    );
  }
  return connectionString;
}

const PASSWORD_SALT_LENGTH = 16;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_OPTIONS = {
  N: 16_384,
  maxmem: 128 * 16_384 * 16 * 2,
  p: 1,
  r: 16,
} as const;

function derivePasswordKey(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS, (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(key);
    });
  });
}

export const voidAuthPassword: VoidAuthPasswordOptions = {
  async hash(password) {
    const salt = randomBytes(PASSWORD_SALT_LENGTH).toString('hex');
    const key = await derivePasswordKey(password, salt);
    return `${salt}:${key.toString('hex')}`;
  },
  async verify({ hash, password }) {
    const [salt, key, ...extra] = hash.split(':');
    if (!salt || !key || extra.length > 0) {
      return false;
    }

    const storedKey = Buffer.from(key, 'hex');
    if (key.length !== SCRYPT_KEY_LENGTH * 2 || storedKey.length !== SCRYPT_KEY_LENGTH) {
      return false;
    }

    const targetKey = await derivePasswordKey(password, salt);
    return timingSafeEqual(targetKey, storedKey);
  },
};

function resolveEmailAndPassword(
  configuredProviders: Array<VoidAuthProvider> | null,
): BetterAuthOptions['emailAndPassword'] | undefined {
  if (!configuredProviders || configuredProviders.includes(VOID_EMAIL_AUTH_PROVIDER)) {
    return {
      enabled: true,
      password: voidAuthPassword,
    };
  }
  return undefined;
}

function resolveSocialProviderCredentials(
  env: VoidAuthEnv,
  provider: VoidSocialAuthProvider,
): { clientId: string; clientSecret: string } {
  const envNames = getVoidAuthProviderEnvNames(provider);
  const clientIdKeys = [envNames.clientId];
  const clientSecretKeys = [envNames.clientSecret];
  if (envNames.legacyClientId) {
    clientIdKeys.push(envNames.legacyClientId);
  }
  if (envNames.legacyClientSecret) {
    clientSecretKeys.push(envNames.legacyClientSecret);
  }
  const clientId = readEnvString(env, ...clientIdKeys);
  const clientSecret = readEnvString(env, ...clientSecretKeys);

  if (!clientId || !clientSecret) {
    throw new Error(
      `auth: Missing credentials for provider '${provider}'. Set ${envNames.clientId} and ${envNames.clientSecret}, or remove '${provider}' from auth.providers.`,
    );
  }

  return { clientId, clientSecret };
}

function resolveSocialProviders(
  env: VoidAuthEnv,
  configuredProviders: Array<VoidAuthProvider> | null,
): BetterAuthOptions['socialProviders'] | undefined {
  if (!configuredProviders) {
    return undefined;
  }

  const providers: Record<string, { clientId: string; clientSecret: string }> = {};

  for (const provider of configuredProviders) {
    if (!isVoidSocialAuthProvider(provider)) {
      continue;
    }
    providers[provider] = resolveSocialProviderCredentials(env, provider);
  }

  return Object.keys(providers).length > 0 ? providers : undefined;
}

function appendAuthHeaders(
  c: Context,
  source: Headers | undefined,
  includeCachePolicy: boolean,
): void {
  if (!source) {
    return;
  }

  source.forEach((value, key) => {
    // getSession's response policy belongs to the session endpoint. An anonymous
    // lookup must not make the application's public page or asset uncacheable.
    if (!includeCachePolicy && ['cache-control', 'pragma'].includes(key.toLowerCase())) {
      return;
    }
    c.header(key, value, {
      append: key.toLowerCase() === 'set-cookie',
    });
  });
  if (
    source.has('set-cookie') &&
    !(source.get('cache-control') ?? '')
      .split(',')
      .some((directive) =>
        ['private', 'no-store', 'no-cache'].includes(directive.trim().toLowerCase()),
      )
  ) {
    c.header('Cache-Control', 'private, no-store');
  }
}

function resolveUserConfig(
  userConfig: VoidAuthConfig | undefined,
  defaults: BetterAuthOptions,
  request: Request,
  env: VoidAuthEnv,
  dialect: VoidAuthDialect,
): BetterAuthOptions {
  const mergeEmailAndPasswordDefaults = (options: BetterAuthOptions): BetterAuthOptions => {
    if (!defaults.emailAndPassword?.password || !options.emailAndPassword) {
      return options;
    }

    return {
      ...options,
      emailAndPassword: {
        ...options.emailAndPassword,
        password: options.emailAndPassword.password ?? defaults.emailAndPassword.password,
      },
    };
  };

  if (!userConfig) {
    return defaults;
  }

  if (typeof userConfig === 'function') {
    return mergeEmailAndPasswordDefaults(userConfig({ defaults, request, env, dialect }));
  }

  return mergeEmailAndPasswordDefaults({ ...defaults, ...userConfig });
}

export function assertRuntimeDialect(
  runtime: VoidAuthRuntimeOptions,
  dialect: VoidAuthDialect,
): void {
  if (runtime.dialect !== dialect) {
    throw new Error(`auth: Runtime mismatch. Expected ${dialect}, received '${runtime.dialect}'.`);
  }
}

export function createVoidAuthRuntime(
  dialect: VoidAuthDialect,
  resolveDatabase: ResolveDatabase,
  runVoidAuthMigrations: VoidAuthRuntimeApi['runVoidAuthMigrations'],
): VoidAuthRuntimeApi {
  async function resolveVoidAuthOptions(
    request: Request,
    env: VoidAuthEnv,
    runtime: VoidAuthRuntimeOptions,
    databaseOverride?: NonNullable<BetterAuthOptions['database']>,
    disposeOverride?: () => Promise<void>,
  ): Promise<{ options: BetterAuthOptions; dispose(): Promise<void> }> {
    assertRuntimeDialect(runtime, dialect);

    const { database, dispose } = databaseOverride
      ? {
          database: databaseOverride,
          dispose: disposeOverride ?? (async () => {}),
        }
      : await resolveDatabase(env);
    const origin = new URL(request.url).origin;
    const emailAndPassword = resolveEmailAndPassword(runtime.providers);
    const socialProviders = resolveSocialProviders(env, runtime.providers);

    const defaults: BetterAuthOptions = {
      baseURL: origin,
      basePath: '/api/auth',
      secret: resolveSecret(env, runtime.dev === true),
      database,
      ...(emailAndPassword ? { emailAndPassword } : {}),
      ...(socialProviders ? { socialProviders } : {}),
      trustedOrigins: [origin],
    };

    return {
      options: resolveUserConfig(runtime.userConfig, defaults, request, env, dialect),
      dispose,
    };
  }

  async function createVoidAuth(
    request: Request,
    env: VoidAuthEnv,
    runtime: VoidAuthRuntimeOptions,
    databaseOverride?: NonNullable<BetterAuthOptions['database']>,
    disposeOverride?: () => Promise<void>,
  ): Promise<{ auth: ReturnType<typeof betterAuth>; dispose(): Promise<void> }> {
    const { options, dispose } = await resolveVoidAuthOptions(
      request,
      env,
      runtime,
      databaseOverride,
      disposeOverride,
    );
    return {
      auth: betterAuth(options),
      dispose,
    };
  }

  async function resolveVoidAuthState(
    request: Request,
    env: VoidAuthEnv,
    runtime: VoidAuthRuntimeOptions,
    databaseOverride?: NonNullable<BetterAuthOptions['database']>,
    disposeOverride?: () => Promise<void>,
  ): Promise<AuthState | null> {
    const { auth, dispose } = await createVoidAuth(
      request,
      env,
      runtime,
      databaseOverride,
      disposeOverride,
    );

    try {
      const result = await auth.api.getSession({
        headers: request.headers,
        asResponse: false,
        returnHeaders: true,
      });

      return (result.response ?? null) as AuthState | null;
    } finally {
      await dispose();
    }
  }

  async function runVoidAuthMiddleware(
    c: Context,
    next: () => Promise<void>,
    runtime: VoidAuthRuntimeOptions,
    databaseOverride?: NonNullable<BetterAuthOptions['database']>,
    disposeOverride?: () => Promise<void>,
  ): Promise<void> {
    // Skip auth for internal routes (cron, queue, migration, binding proxy).
    // Still set user/session to null so downstream middleware that checks
    // these context variables gets the expected sentinel (not undefined).
    if (c.req.path.startsWith('/__')) {
      c.set('user', null);
      c.set('session', null);
      return next();
    }

    const { auth, dispose } = await createVoidAuth(
      c.req.raw,
      c.env as VoidAuthEnv,
      runtime,
      databaseOverride,
      disposeOverride,
    );
    c.set('__voidAuth', auth);

    try {
      const result = await auth.api.getSession({
        headers: c.req.raw.headers,
        asResponse: false,
        returnHeaders: true,
      });

      const state = (result.response ?? null) as AuthState | null;
      c.set('user', state?.user ?? null);
      c.set('session', state?.session ?? null);

      await authContext.run({ user: state?.user ?? null, state }, async () => {
        await next();
      });

      const credentialed = ['cookie', 'authorization', 'cf-access-jwt-assertion'].some((header) =>
        c.req.raw.headers.has(header),
      );
      appendAuthHeaders(
        c,
        result.headers,
        state !== null || credentialed || result.headers?.has('set-cookie') === true,
      );
    } finally {
      await dispose();
    }
  }

  async function handleVoidAuthRequest(
    c: Context,
    runtime: VoidAuthRuntimeOptions,
    databaseOverride?: NonNullable<BetterAuthOptions['database']>,
    disposeOverride?: () => Promise<void>,
  ): Promise<Response> {
    const existingAuth = c.get('__voidAuth') as ReturnType<typeof betterAuth> | undefined;
    if (existingAuth) {
      return existingAuth.handler(c.req.raw);
    }

    const { auth, dispose } = await createVoidAuth(
      c.req.raw,
      c.env as VoidAuthEnv,
      runtime,
      databaseOverride,
      disposeOverride,
    );
    try {
      return await auth.handler(c.req.raw);
    } finally {
      await dispose();
    }
  }

  return {
    resolveVoidAuthOptions,
    createVoidAuth,
    resolveVoidAuthState,
    runVoidAuthMiddleware,
    handleVoidAuthRequest,
    runVoidAuthMigrations,
  };
}
