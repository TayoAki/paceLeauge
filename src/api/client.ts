import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

import { env, isBackendConfigured } from '@/config/env';
import { chunkedSecureStorage } from '@/features/account/auth-storage';

import { createPaceApi, type PaceApi } from './pace-api';
import { supabaseTransport } from './supabase-transport';

/**
 * The only backend client in the app: public anon key + the user's session. All privileged
 * operations happen server-side behind RLS and SECURITY DEFINER functions.
 */
function build(): { supabase: SupabaseClient; api: PaceApi } | null {
  if (!isBackendConfigured) return null;
  const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: {
      storage: Platform.OS === 'web' ? undefined : chunkedSecureStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
    global: { headers: { 'x-client-info': 'paceleague-app/0.1.0' } },
  });
  if (Platform.OS !== 'web') {
    // Refresh tokens only while the app is in the foreground (Supabase React Native guidance).
    AppState.addEventListener('change', (state) => {
      if (state === 'active') supabase.auth.startAutoRefresh();
      else supabase.auth.stopAutoRefresh();
    });
  }
  return { supabase, api: createPaceApi(supabaseTransport(supabase)) };
}

const backend = build();

export const supabase = backend?.supabase ?? null;
export const api = backend?.api ?? null;
