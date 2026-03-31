import { betterAuth, type BetterAuthOptions } from "better-auth";
import type { Context } from "hono";
import type { VoidAuthMigrationSchema } from "../auth/drizzle";
import {
  VOID_EMAIL_AUTH_PROVIDER,
  getVoidAuthProviderEnvNames,
  isVoidSocialAuthProvider,
  type VoidAuthProvider,
  type VoidSocialAuthProvider,
} from "../auth/providers";
import { authContext, type AuthState, type VoidAuthConfig } from "./auth";

export type VoidAuthDialect = "sqlite" | "postgresql";

export interface VoidAuthRuntimeOptions {
  dialect: VoidAuthDialect;
  providers: readonly VoidAuthProvider[] | null;
  userConfig?: VoidAuthConfig;
}

export interface VoidAuthEnv extends Record<string, unknown> {
  DB?: D1Database;
  DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString?: string };
  BETTER_AUTH_SECRET?: string;
  GITHUB_OAUTH_ID?: string;
  GITHUB_OAUTH_SECRET?: string;
  GOOGLE_OAUTH_ID?: string;
  GOOGLE_OAUTH_SECRET?: string;
}

export interface ResolvedDatabase {
  database: NonNullable<BetterAuthOptions["database"]>;
  dispose(): Promise<void>;
}

type ResolveDatabase = (env: VoidAuthEnv) => Promise<ResolvedDatabase>;

export interface VoidAuthRuntimeApi {
  resolveVoidAuthOptions(
    request: Request,
    env: VoidAuthEnv,
    runtime: VoidAuthRuntimeOptions,
    databaseOverride?: NonNullable<BetterAuthOptions["database"]>,
    disposeOverride?: () => Promise<void>,
  ): Promise<{ options: BetterAuthOptions; dispose(): Promise<void> }>;
  createVoidAuth(
    request: Request,
    env: VoidAuthEnv,
    runtime: VoidAuthRuntimeOptions,
    databaseOverride?: NonNullable<BetterAuthOptions["database"]>,
    disposeOverride?: () => Promise<void>,
  ): Promise<{ auth: ReturnType<typeof betterAuth>; dispose(): Promise<void> }>;
  resolveVoidAuthState(
    request: Request,
    env: VoidAuthEnv,
    runtime: VoidAuthRuntimeOptions,
    databaseOverride?: NonNullable<BetterAuthOptions["database"]>,
    disposeOverride?: () => Promise<void>,
  ): Promise<AuthState | null>;
  runVoidAuthMiddleware(
    c: Context,
    next: () => Promise<void>,
    runtime: VoidAuthRuntimeOptions,
    databaseOverride?: NonNullable<BetterAuthOptions["database"]>,
    disposeOverride?: () => Promise<void>,
  ): Promise<void>;
  handleVoidAuthRequest(
    c: Context,
    runtime: VoidAuthRuntimeOptions,
    databaseOverride?: NonNullable<BetterAuthOptions["database"]>,
    disposeOverride?: () => Promise<void>,
  ): Promise<Response>;
  runVoidAuthMigrations(
    request: Request,
    env: VoidAuthEnv,
    runtime: VoidAuthRuntimeOptions,
    migrationSchema: VoidAuthMigrationSchema,
  ): Promise<void>;
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".local");
}

function resolveSecret(request: Request, env: VoidAuthEnv): string {
  const explicit =
    typeof env.BETTER_AUTH_SECRET === "string" && env.BETTER_AUTH_SECRET.length > 0
      ? env.BETTER_AUTH_SECRET
      : undefined;
  if (explicit) return explicit;

  const url = new URL(request.url);
  if (isLocalHost(url.hostname)) {
    return "void-dev-better-auth-secret-1234567890";
  }

  throw new Error("Missing Better Auth secret. Set BETTER_AUTH_SECRET.");
}

function readEnvString(env: VoidAuthEnv, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function resolveEmailAndPassword(
  configuredProviders: readonly VoidAuthProvider[] | null,
): BetterAuthOptions["emailAndPassword"] | undefined {
  if (!configuredProviders || configuredProviders.includes(VOID_EMAIL_AUTH_PROVIDER)) {
    return { enabled: true };
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
  if (envNames.legacyClientId) clientIdKeys.push(envNames.legacyClientId);
  if (envNames.legacyClientSecret) clientSecretKeys.push(envNames.legacyClientSecret);
  const clientId = readEnvString(env, ...clientIdKeys);
  const clientSecret = readEnvString(env, ...clientSecretKeys);

  if (!clientId || !clientSecret) {
    throw new Error(
      `Missing auth credentials for provider "${provider}". Set ${envNames.clientId} and ${envNames.clientSecret}, or remove "${provider}" from auth.providers.`,
    );
  }

  return { clientId, clientSecret };
}

function resolveSocialProviders(
  env: VoidAuthEnv,
  configuredProviders: readonly VoidAuthProvider[] | null,
): BetterAuthOptions["socialProviders"] | undefined {
  if (!configuredProviders) return undefined;

  const providers: Record<string, { clientId: string; clientSecret: string }> = {};

  for (const provider of configuredProviders) {
    if (!isVoidSocialAuthProvider(provider)) continue;
    providers[provider] = resolveSocialProviderCredentials(env, provider);
  }

  return Object.keys(providers).length > 0 ? providers : undefined;
}

function appendAuthHeaders(target: Headers, source?: Headers): void {
  if (!source) return;

  source.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      target.append(key, value);
      return;
    }
    target.set(key, value);
  });
}

function resolveUserConfig(
  userConfig: VoidAuthConfig | undefined,
  defaults: BetterAuthOptions,
  request: Request,
  env: VoidAuthEnv,
  dialect: VoidAuthDialect,
): BetterAuthOptions {
  if (!userConfig) return defaults;

  if (typeof userConfig === "function") {
    return userConfig({ defaults, request, env, dialect });
  }

  return { ...defaults, ...userConfig };
}

function assertRuntimeDialect(runtime: VoidAuthRuntimeOptions, dialect: VoidAuthDialect): void {
  if (runtime.dialect !== dialect) {
    throw new Error(
      `Void auth runtime mismatch: expected ${dialect}, received ${runtime.dialect}.`,
    );
  }
}

export function createVoidAuthRuntime(
  dialect: VoidAuthDialect,
  resolveDatabase: ResolveDatabase,
  runVoidAuthMigrations: VoidAuthRuntimeApi["runVoidAuthMigrations"],
): VoidAuthRuntimeApi {
  async function resolveVoidAuthOptions(
    request: Request,
    env: VoidAuthEnv,
    runtime: VoidAuthRuntimeOptions,
    databaseOverride?: NonNullable<BetterAuthOptions["database"]>,
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
      basePath: "/api/auth",
      secret: resolveSecret(request, env),
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
    databaseOverride?: NonNullable<BetterAuthOptions["database"]>,
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
    databaseOverride?: NonNullable<BetterAuthOptions["database"]>,
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
    databaseOverride?: NonNullable<BetterAuthOptions["database"]>,
    disposeOverride?: () => Promise<void>,
  ): Promise<void> {
    // Skip auth for internal routes (cron, queue, migration, binding proxy).
    // Still set user/session to null so downstream middleware that checks
    // these context variables gets the expected sentinel (not undefined).
    if (c.req.path.startsWith("/__")) {
      c.set("user", null);
      c.set("session", null);
      return next();
    }

    const { auth, dispose } = await createVoidAuth(
      c.req.raw,
      c.env as VoidAuthEnv,
      runtime,
      databaseOverride,
      disposeOverride,
    );
    c.set("__voidAuth", auth);

    try {
      const result = await auth.api.getSession({
        headers: c.req.raw.headers,
        asResponse: false,
        returnHeaders: true,
      });

      const state = (result.response ?? null) as AuthState | null;
      c.set("user", state?.user ?? null);
      c.set("session", state?.session ?? null);

      await authContext.run({ user: state?.user ?? null, state }, async () => {
        await next();
      });

      appendAuthHeaders(c.res.headers, result.headers);
    } finally {
      await dispose();
    }
  }

  async function handleVoidAuthRequest(
    c: Context,
    runtime: VoidAuthRuntimeOptions,
    databaseOverride?: NonNullable<BetterAuthOptions["database"]>,
    disposeOverride?: () => Promise<void>,
  ): Promise<Response> {
    const existingAuth = c.get("__voidAuth") as ReturnType<typeof betterAuth> | undefined;
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
    resolveVoidAuthOptions: resolveVoidAuthOptions,
    createVoidAuth: createVoidAuth,
    resolveVoidAuthState: resolveVoidAuthState,
    runVoidAuthMiddleware: runVoidAuthMiddleware,
    handleVoidAuthRequest: handleVoidAuthRequest,
    runVoidAuthMigrations: runVoidAuthMigrations,
  };
}
