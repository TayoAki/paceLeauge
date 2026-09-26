/**
 * Public runtime configuration. EXPO_PUBLIC_* values are inlined at build time.
 * Never read privileged secrets here: everything in this file ships in the app bundle.
 */
type AppEnv = 'development' | 'staging' | 'production' | 'test';

function appEnv(value: string | undefined): AppEnv {
  return value === 'staging' || value === 'production' || value === 'test' ? value : 'development';
}

export const env = {
  appEnv: appEnv(process.env.EXPO_PUBLIC_APP_ENV),
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? '',
  supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
  supportEmail: process.env.EXPO_PUBLIC_SUPPORT_EMAIL ?? '',
  termsUrl: process.env.EXPO_PUBLIC_TERMS_URL ?? '',
  privacyUrl: process.env.EXPO_PUBLIC_PRIVACY_URL ?? '',
} as const;

export const isBackendConfigured = env.supabaseUrl.length > 0 && env.supabaseAnonKey.length > 0;
export const isProduction = env.appEnv === 'production';
