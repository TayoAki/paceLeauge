/**
 * API service configuration, read once from the environment and validated. Invalid or unsafe
 * settings stop the process at boot rather than surfacing later as a security hole — for example,
 * production refuses to start without a real email provider or with a development sign-in code.
 */
export type AppEnv = 'development' | 'test' | 'staging' | 'production';
export type EmailProvider = 'resend' | 'postmark' | 'log' | 'memory';

export interface ServerConfig {
  appEnv: AppEnv;
  host: string;
  port: number;
  databaseUrl: string;
  /** TLS to Postgres: off on Railway's private network, `require`/`no-verify` for public URLs. */
  databaseSsl: 'disable' | 'require' | 'no-verify';
  databasePoolMax: number;
  /** Identifies the app to the API (sent as `apikey`). Public by design: it ships in the app. */
  publicApiKey: string;
  /** HS256 signing secret; when absent one is generated once and kept in the database. */
  jwtSecret: string | null;
  accessTokenTtlS: number;
  refreshTokenTtlS: number;
  codes: { ttlS: number; maxAttempts: number; resendCooldownS: number; maxPerEmailPerHour: number };
  /** Development only: every address accepts this code (the local walkthrough uses it). */
  devFixedCode: string | null;
  /** One address that accepts a fixed code, for App Review and staging checks. */
  reviewAccount: { email: string; code: string } | null;
  email: { provider: EmailProvider; apiKey: string | null; from: string | null; replyTo: string | null };
  /** Sign in with Apple audiences (the iOS bundle identifiers). Empty disables Apple. */
  appleAudiences: string[];
  /** Email + password accounts (sign-up, sign-in, change password). */
  passwordSignIn: boolean;
  corsOrigins: string[] | '*';
  /** Behind Railway's proxy the client address is the last X-Forwarded-For hop. */
  trustProxy: boolean;
  runJobs: boolean;
  /** Staging/development convenience applied once: turn league scoring on. */
  bootstrapEnableCompetition: boolean;
  /** Strava export (docs/ROADMAP.md 2.3); null when not configured. */
  strava: StravaConfig | null;
  /** Garmin through the Terra aggregator (docs/ROADMAP.md 2.4); null when not configured. */
  garmin: GarminConfig | null;
}

export interface GarminConfig {
  devId: string;
  apiKey: string;
  /** Terra's webhook signing secret. */
  webhookSecret: string;
  /** Where the widget may send the runner back: the app's URL scheme and the web app. */
  returnPrefixes: string[];
}

export interface StravaConfig {
  clientId: string;
  clientSecret: string;
  /** AES-256-GCM key for the tokens stored in the database (32 bytes). */
  tokenKey: Buffer;
  /** Where Strava sends the runner back: `${PUBLIC_URL}/integrations/strava/callback`. */
  redirectUri: string;
  /** Where the service may then send the runner: the app's URL scheme and the web app. */
  returnPrefixes: string[];
  /** Shared with Strava when subscribing to its webhook (athlete deauthorizations). */
  webhookVerifyToken: string | null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

const SIX_DIGITS = /^\d{6}$/;
const DEV_PUBLIC_KEY = 'pl_dev_public_key';

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${name} must be true or false`);
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: Env = process.env): ServerConfig {
  const appEnv = (env.APP_ENV ?? 'development') as AppEnv;
  if (!['development', 'test', 'staging', 'production'].includes(appEnv)) throw new ConfigError('APP_ENV must be development, test, staging or production');
  const deployed = appEnv === 'staging' || appEnv === 'production';

  const databaseUrl = env.DATABASE_URL ?? '';
  if (!databaseUrl) throw new ConfigError('DATABASE_URL is required');
  const databaseSsl = (env.DATABASE_SSL ?? 'disable') as ServerConfig['databaseSsl'];
  if (!['disable', 'require', 'no-verify'].includes(databaseSsl)) throw new ConfigError('DATABASE_SSL must be disable, require or no-verify');

  const publicApiKey = env.PUBLIC_API_KEY ?? (deployed ? '' : DEV_PUBLIC_KEY);
  if (publicApiKey.length < 16) throw new ConfigError('PUBLIC_API_KEY is required (at least 16 characters)');

  const jwtSecret = env.JWT_SECRET?.trim() || null;
  if (jwtSecret !== null && jwtSecret.length < 32) throw new ConfigError('JWT_SECRET must be at least 32 characters');

  const devFixedCode = env.DEV_FIXED_CODE?.trim() || null;
  if (devFixedCode !== null) {
    if (appEnv !== 'development' && appEnv !== 'test') throw new ConfigError('DEV_FIXED_CODE is only allowed in development and test');
    if (!SIX_DIGITS.test(devFixedCode)) throw new ConfigError('DEV_FIXED_CODE must be six digits');
  }

  const reviewEmail = env.REVIEW_ACCOUNT_EMAIL?.trim().toLowerCase() || null;
  const reviewCode = env.REVIEW_ACCOUNT_CODE?.trim() || null;
  if ((reviewEmail === null) !== (reviewCode === null)) throw new ConfigError('Set both REVIEW_ACCOUNT_EMAIL and REVIEW_ACCOUNT_CODE, or neither');
  if (reviewCode !== null && !SIX_DIGITS.test(reviewCode)) throw new ConfigError('REVIEW_ACCOUNT_CODE must be six digits');

  const provider = (env.EMAIL_PROVIDER ?? (deployed ? '' : 'log')) as EmailProvider;
  if (!['resend', 'postmark', 'log', 'memory'].includes(provider)) throw new ConfigError('EMAIL_PROVIDER must be resend, postmark or log');
  const email = { provider, apiKey: env.EMAIL_API_KEY?.trim() || null, from: env.EMAIL_FROM?.trim() || null, replyTo: env.EMAIL_REPLY_TO?.trim() || null };
  if ((provider === 'resend' || provider === 'postmark') && (!email.apiKey || !email.from)) {
    throw new ConfigError(`EMAIL_PROVIDER=${provider} needs EMAIL_API_KEY and EMAIL_FROM`);
  }
  if (appEnv === 'production' && (provider === 'log' || provider === 'memory')) {
    throw new ConfigError('Production must deliver sign-in codes by email (EMAIL_PROVIDER=resend or postmark)');
  }

  const bootstrapEnableCompetition = bool(env, 'BOOTSTRAP_ENABLE_COMPETITION', false);
  if (bootstrapEnableCompetition && appEnv === 'production') {
    throw new ConfigError('BOOTSTRAP_ENABLE_COMPETITION is not allowed in production; use private.set_flag with a reason');
  }

  const cors = env.CORS_ORIGINS?.trim();
  const corsOrigins = cors === '*' ? '*' : list(cors);
  // Where an integration may send the runner back: the app's scheme, plus the web app's origins
  // (never a wildcard, since the return is a redirect).
  const returnPrefixes = [...list(env.APP_RETURN_URLS ?? 'paceleague://'), ...(corsOrigins === '*' ? [] : corsOrigins.map((o) => `${o}/`))];
  const strava = stravaConfig(env, deployed, returnPrefixes);
  const garmin = garminConfig(env, returnPrefixes);
  return {
    appEnv,
    host: env.HOST ?? '::',
    port: int(env, 'PORT', 8080, 1, 65535),
    databaseUrl,
    databaseSsl,
    databasePoolMax: int(env, 'DATABASE_POOL_MAX', 10, 1, 100),
    publicApiKey,
    jwtSecret,
    accessTokenTtlS: int(env, 'ACCESS_TOKEN_TTL_SECONDS', 3600, 60, 86_400),
    refreshTokenTtlS: int(env, 'REFRESH_TOKEN_TTL_DAYS', 60, 1, 365) * 86_400,
    codes: {
      ttlS: int(env, 'CODE_TTL_SECONDS', 600, 60, 3600),
      maxAttempts: int(env, 'CODE_MAX_ATTEMPTS', 5, 1, 20),
      resendCooldownS: int(env, 'CODE_RESEND_COOLDOWN_SECONDS', 60, 0, 3600),
      maxPerEmailPerHour: int(env, 'CODE_MAX_PER_EMAIL_PER_HOUR', 5, 1, 100),
    },
    devFixedCode,
    reviewAccount: reviewEmail && reviewCode ? { email: reviewEmail, code: reviewCode } : null,
    email,
    appleAudiences: list(env.APPLE_AUDIENCES),
    passwordSignIn: bool(env, 'PASSWORD_SIGN_IN', true),
    corsOrigins,
    trustProxy: bool(env, 'TRUST_PROXY', env.RAILWAY_ENVIRONMENT_NAME !== undefined || env.RAILWAY_ENVIRONMENT !== undefined),
    runJobs: bool(env, 'RUN_JOBS', true),
    bootstrapEnableCompetition,
    strava,
    garmin,
  };
}

const TERRA_KEYS = ['TERRA_DEV_ID', 'TERRA_API_KEY', 'TERRA_WEBHOOK_SECRET'] as const;

function garminConfig(env: Env, returnPrefixes: string[]): GarminConfig | null {
  const set = TERRA_KEYS.filter((k) => env[k]?.trim());
  if (set.length === 0) return null;
  if (set.length !== TERRA_KEYS.length) throw new ConfigError(`Garmin sync needs ${TERRA_KEYS.join(', ')} together`);
  return { devId: env.TERRA_DEV_ID!.trim(), apiKey: env.TERRA_API_KEY!.trim(), webhookSecret: env.TERRA_WEBHOOK_SECRET!.trim(), returnPrefixes };
}

const STRAVA_KEYS = ['STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET', 'STRAVA_TOKEN_KEY', 'PUBLIC_URL'] as const;

function stravaConfig(env: Env, deployed: boolean, returnPrefixes: string[]): StravaConfig | null {
  const set = STRAVA_KEYS.filter((k) => env[k]?.trim());
  if (set.length === 0 || (set.length === 1 && set[0] === 'PUBLIC_URL')) return null;
  if (set.length !== STRAVA_KEYS.length) throw new ConfigError(`Strava needs ${STRAVA_KEYS.join(', ')} together`);
  const clientId = env.STRAVA_CLIENT_ID!.trim();
  if (!/^\d{1,12}$/.test(clientId)) throw new ConfigError('STRAVA_CLIENT_ID must be the numeric client id');
  const tokenKey = Buffer.from(env.STRAVA_TOKEN_KEY!.trim(), 'base64');
  if (tokenKey.length !== 32) throw new ConfigError('STRAVA_TOKEN_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
  let publicUrl: URL;
  try {
    publicUrl = new URL(env.PUBLIC_URL!.trim());
  } catch {
    throw new ConfigError('PUBLIC_URL must be the API’s public URL');
  }
  if (deployed && publicUrl.protocol !== 'https:') throw new ConfigError('PUBLIC_URL must use https when deployed');
  return {
    clientId,
    clientSecret: env.STRAVA_CLIENT_SECRET!.trim(),
    tokenKey,
    redirectUri: new URL('/integrations/strava/callback', publicUrl).toString(),
    returnPrefixes,
    webhookVerifyToken: env.STRAVA_WEBHOOK_VERIFY_TOKEN?.trim() || null,
  };
}
