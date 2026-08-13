import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

interface AuthState {
  session: Session | null;
  user: User | null;
  loading: boolean;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthState>({ session: null, user: null, loading: true, isAdmin: false });

async function checkIsAdmin(userId: string): Promise<boolean> {
  const { count, error } = await supabase
    .from('admin_users')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  if (error) {
    return false;
  }
  return (count ?? 0) > 0;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ session: null, user: null, loading: true, isAdmin: false });

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(async ({ data }) => {
      const user = data.session?.user ?? null;
      let isAdmin = false;
      if (user) {
        isAdmin = await checkIsAdmin(user.id);
      }
      if (mounted) {
        setState({ session: data.session, user, loading: false, isAdmin });
      }
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, session) => {
      const user = session?.user ?? null;
      let isAdmin = false;
      if (user) {
        isAdmin = await checkIsAdmin(user.id);
      }
      if (mounted) {
        setState({ session, user, loading: false, isAdmin });
      }
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
