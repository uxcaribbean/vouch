import type { Session } from "@supabase/supabase-js";
import type { Tables } from "@vouch/shared";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";

import { maybeAutoResync } from "@/lib/contact-sync";
import { configureNotifications, registerForPush } from "@/lib/notifications";
import { supabase } from "@/lib/supabase";

export type Profile = Tables<"users">;

type AuthState = {
  session: Session | null;
  /** null while logged out OR before profile-setup is completed */
  profile: Profile | null;
  /** true until the persisted session + profile have been loaded once */
  initializing: boolean;
  refreshProfile: () => Promise<Profile | null>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [initializing, setInitializing] = useState(true);

  const loadProfile = useCallback(async (userId: string | undefined) => {
    if (!userId) {
      setProfile(null);
      return null;
    }
    const { data } = await supabase
      .from("users")
      .select()
      .eq("id", userId)
      .maybeSingle();
    setProfile(data ?? null);
    return data ?? null;
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      await loadProfile(data.session?.user.id);
      setInitializing(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, nextSession) => {
        setSession(nextSession);
        // profile loads lazily; screens call refreshProfile after sign-in
        if (!nextSession) setProfile(null);
      },
    );
    return () => subscription.subscription.unsubscribe();
  }, [loadProfile]);

  const refreshProfile = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    return loadProfile(data.session?.user.id);
  }, [loadProfile]);

  // Foreground re-sync (spec M4.2, max once/24h) — fires once per app
  // session, the first time both a session and a completed profile exist.
  // maybeAutoResync no-ops unless permission was already granted and
  // contact_sync_enabled is on, so this never prompts or spams retries.
  const autoResyncedRef = useRef(false);
  useEffect(() => {
    if (autoResyncedRef.current || !session || !profile) return;
    autoResyncedRef.current = true;
    void maybeAutoResync(session, profile);
  }, [session, profile]);

  // Foreground presentation + notification-tap routing (spec M8). Lives at
  // provider level so a tap is handled once, wherever the app happens to be.
  useEffect(() => {
    let disposed = false;
    let teardown: (() => void) | undefined;
    void configureNotifications().then((dispose) => {
      if (disposed) dispose();
      else teardown = dispose;
    });
    return () => {
      disposed = true;
      teardown?.();
    };
  }, []);

  // Push token registration, guarded exactly like the re-sync above: once per
  // app session, only once a session and a completed profile both exist.
  // registerForPush never throws and never blocks — no push is a normal state.
  const pushRegisteredRef = useRef(false);
  useEffect(() => {
    if (pushRegisteredRef.current || !session || !profile) return;
    pushRegisteredRef.current = true;
    void registerForPush(session);
  }, [session, profile]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setProfile(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{ session, profile, initializing, refreshProfile, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
