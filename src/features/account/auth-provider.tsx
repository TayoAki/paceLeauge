import type { Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { supabase } from '@/api/client';

export type AuthState =
  | { status: 'loading' }
  | { status: 'signed_out' }
  | { status: 'signed_in'; userId: string; email: string | null; session: Session };

const AuthContext = createContext<AuthState>({ status: 'loading' });

function fromSession(session: Session | null): AuthState {
  return session ? { status: 'signed_in', userId: session.user.id, email: session.user.email ?? null, session } : { status: 'signed_out' };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(supabase ? { status: 'loading' } : { status: 'signed_out' });

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    supabase.auth
      .getSession()
      .then(({ data }) => alive && setState(fromSession(data.session)))
      .catch(() => alive && setState({ status: 'signed_out' }));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (alive) setState(fromSession(session));
    });
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
