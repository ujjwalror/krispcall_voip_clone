'use client';

import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { Profile, Organization } from '@/lib/types';
import { useRouter } from 'next/navigation';
import { getSessionIdFromSession } from '@/lib/auth/session';

interface AuthContextType {
  user: User | null;
  profile: Profile | null;
  organization: Organization | null;
  isLoading: boolean;
  error: string | null;
  isDisplaced: boolean;
  displacedReason: string | null;
  isSessionRegistered: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  displaceSession: (reason?: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  profile: null,
  organization: null,
  isLoading: true,
  error: null,
  isDisplaced: false,
  displacedReason: null,
  isSessionRegistered: false,
  signOut: async () => {},
  refreshProfile: async () => {},
  displaceSession: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDisplaced, setIsDisplaced] = useState(false);
  const [displacedReason, setDisplacedReason] = useState<string | null>(null);
  const [isSessionRegistered, setIsSessionRegistered] = useState(false);

  const registeredSessionIdRef = useRef<string | null>(null);
  const realtimeChannelRef = useRef<any>(null);

  const router = useRouter();
  const supabase = createClient();

  const fetchProfile = async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();

      const profileData = data as Profile | null;

      if (error || !profileData) {
        console.error('Error loading profile:', error);
        setError('Your account profile was not found. Please contact your administrator.');
        setProfile(null);
        setOrganization(null);
        return null;
      }

      if (!profileData.active) {
        setError('Your account is currently inactive. Please contact your administrator.');
        setProfile(null);
        setOrganization(null);
        return null;
      }

      setError(null);
      setProfile(profileData);

      if (profileData.organization_id) {
        const { data: orgData } = await supabase
          .from('organizations')
          .select('*')
          .eq('id', profileData.organization_id)
          .maybeSingle();

        setOrganization(orgData as Organization | null);
      } else {
        setOrganization(null);
      }

      return profileData;
    } catch (err) {
      console.error('Unexpected error fetching profile:', err);
      setError('System error loading your user account.');
      setProfile(null);
      setOrganization(null);
      return null;
    }
  };

  const refreshProfile = async () => {
    if (user?.id) {
      await fetchProfile(user.id);
    }
  };

  const handleDisplaceSession = useCallback(async (reason?: string) => {
    console.warn('[AuthProvider] Active session displaced.');
    setIsDisplaced(true);
    setDisplacedReason(reason || 'Your account was signed in on another device.');

    // Unsubscribe Realtime listener
    if (realtimeChannelRef.current) {
      try {
        supabase.removeChannel(realtimeChannelRef.current);
      } catch (e) {
        // Ignore channel cleanup errors
      }
      realtimeChannelRef.current = null;
    }

    registeredSessionIdRef.current = null;
    setIsSessionRegistered(false);

    // CRITICAL: Perform LOCAL signout so we do NOT revoke the new replacement session on the remote server
    try {
      await supabase.auth.signOut({ scope: 'local' });
    } catch (err) {
      console.warn('[AuthProvider] Error during local signout execution:', err);
    }

    setUser(null);
    setProfile(null);
    setOrganization(null);

    router.push('/login?error=session_displaced');
    router.refresh();
  }, [supabase, router]);

  // Setup Realtime listener for active session changes
  const setupRealtimeSessionListener = useCallback((userId: string, currentSessionId: string) => {
    if (realtimeChannelRef.current) {
      try {
        supabase.removeChannel(realtimeChannelRef.current);
      } catch (e) {
        // Ignore
      }
      realtimeChannelRef.current = null;
    }

    const channel = supabase.channel(`active_session:${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_active_sessions',
          filter: `user_id=eq.${userId}`,
        },
        async (payload) => {
          const newActiveSessionId = (payload.new as any)?.active_session_id;
          if (newActiveSessionId && newActiveSessionId !== currentSessionId) {
            console.warn('[AuthProvider] Realtime event: user active session updated to new session ID.');
            await handleDisplaceSession('Your account was signed in on another device.');
          }
        }
      )
      .subscribe();

    realtimeChannelRef.current = channel;
  }, [supabase, handleDisplaceSession]);

  // Register active session via RPC
  const registerActiveSession = useCallback(async (session: Session) => {
    const sessionId = getSessionIdFromSession(session);
    if (!sessionId) return;

    // Prevent loop / repeated registration for the exact same session_id (e.g. TOKEN_REFRESHED)
    if (registeredSessionIdRef.current === sessionId) return;

    try {
      const { data, error } = await supabase.rpc('register_active_session');

      if (error) {
        console.warn('[AuthProvider] register_active_session RPC error:', error.message);
        return;
      }

      const authoritativeSessionId = (data as any)?.active_session_id;

      if (authoritativeSessionId && authoritativeSessionId !== sessionId) {
        // Current session was rejected by race-safe DB logic because a newer session already exists
        console.warn('[AuthProvider] Current session registration rejected: newer session is active in database.');
        await handleDisplaceSession('Session replaced by newer login on another device.');
        return;
      }

      registeredSessionIdRef.current = sessionId;
      setIsSessionRegistered(true);

      // Subscribe to Realtime postgres_changes
      setupRealtimeSessionListener(session.user.id, sessionId);
    } catch (err) {
      console.error('[AuthProvider] Exception during active session registration:', err);
    }
  }, [supabase, handleDisplaceSession, setupRealtimeSessionListener]);

  useEffect(() => {
    let isMounted = true;

    const initializeAuth = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) {
          if (isMounted) setUser(session.user);
          await fetchProfile(session.user.id);
          await registerActiveSession(session);
        } else {
          if (isMounted) {
            setUser(null);
            setProfile(null);
            setOrganization(null);
          }
        }
      } catch (err) {
        console.error('Auth initialization error:', err);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };

    initializeAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (session?.user) {
        setUser(session.user);
        await fetchProfile(session.user.id);
        await registerActiveSession(session);
      } else {
        setUser(null);
        setProfile(null);
        setOrganization(null);
        setError(null);
        setIsSessionRegistered(false);
        registeredSessionIdRef.current = null;
        if (realtimeChannelRef.current) {
          try {
            supabase.removeChannel(realtimeChannelRef.current);
          } catch (e) {
            // Ignore
          }
          realtimeChannelRef.current = null;
        }
      }
      setIsLoading(false);
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
      if (realtimeChannelRef.current) {
        try {
          supabase.removeChannel(realtimeChannelRef.current);
        } catch (e) {
          // Ignore
        }
        realtimeChannelRef.current = null;
      }
    };
  }, [registerActiveSession, supabase]);

  const signOut = async () => {
    setIsLoading(true);

    if (realtimeChannelRef.current) {
      try {
        supabase.removeChannel(realtimeChannelRef.current);
      } catch (e) {
        // Ignore
      }
      realtimeChannelRef.current = null;
    }

    registeredSessionIdRef.current = null;
    setIsSessionRegistered(false);

    // Explicit scope: 'local' for normal user logout to avoid revoking session on replacement device
    await supabase.auth.signOut({ scope: 'local' });

    setUser(null);
    setProfile(null);
    setOrganization(null);
    setError(null);
    setIsLoading(false);
    router.push('/login');
    router.refresh();
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        organization,
        isLoading,
        error,
        isDisplaced,
        displacedReason,
        isSessionRegistered,
        signOut,
        refreshProfile,
        displaceSession: handleDisplaceSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
