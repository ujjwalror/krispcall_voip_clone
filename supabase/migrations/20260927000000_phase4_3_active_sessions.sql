-- Phase 4.3A: Active Session Database Foundation
-- Single Active Session per User Authority Store & Server-Derived RPC

-- 1. Create dedicated user_active_sessions table
CREATE TABLE IF NOT EXISTS public.user_active_sessions (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    active_session_id TEXT NOT NULL,
    session_created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable Replica Identity FULL for Realtime change payload completeness
ALTER TABLE public.user_active_sessions REPLICA IDENTITY FULL;

-- 2. Enable Row Level Security (RLS)
ALTER TABLE public.user_active_sessions ENABLE ROW LEVEL SECURITY;

-- 3. RLS Policies
-- Authenticated users may ONLY read their own active session row.
-- No user (owner, admin, manager, agent) can read another user's active session.
DROP POLICY IF EXISTS user_active_sessions_select_own ON public.user_active_sessions;
CREATE POLICY user_active_sessions_select_own
    ON public.user_active_sessions
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- Direct INSERT, UPDATE, DELETE permissions are omitted for authenticated & anon.
-- All write operations MUST be executed via the SECURITY DEFINER register_active_session() RPC.

-- 4. Table Grants & Revokes
REVOKE ALL ON TABLE public.user_active_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.user_active_sessions TO authenticated;

-- 5. Server-Derived Active Session Registration RPC
-- Derives user_id from auth.uid() and session_id from auth.jwt() ->> 'session_id'.
-- Queries auth.sessions for microsecond-precise session creation timestamp.
-- Performs race-safe conditional UPSERT (only updates if incoming session_created_at >= stored).
-- Zero client-controlled parameters.
CREATE OR REPLACE FUNCTION public.register_active_session()
RETURNS public.user_active_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid;
    v_session_id text;
    v_session_created_at timestamptz;
    v_result public.user_active_sessions;
BEGIN
    -- Derive authenticated user identity
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Unauthenticated request: auth.uid() is null';
    END IF;

    -- Derive session identity from JWT claims
    v_session_id := nullif(trim(auth.jwt() ->> 'session_id'), '');
    IF v_session_id IS NULL THEN
        RAISE EXCEPTION 'Unauthenticated request: session_id claim is missing from authenticated JWT';
    END IF;

    -- Query authoritative session creation timestamp from auth.sessions table
    SELECT created_at INTO v_session_created_at
    FROM auth.sessions
    WHERE id = v_session_id::uuid
      AND user_id = v_user_id;

    -- Fallback to JWT 'iat' claim if session row is not directly found in auth.sessions
    IF v_session_created_at IS NULL THEN
        IF (auth.jwt() ->> 'iat') IS NOT NULL THEN
            v_session_created_at := to_timestamp((auth.jwt() ->> 'iat')::double precision);
        ELSE
            v_session_created_at := now();
        END IF;
    END IF;

    -- Atomic race-safe upsert for single active session per user.
    -- Only updates if the incoming session's creation timestamp is NEWER THAN OR EQUAL TO the existing active session.
    INSERT INTO public.user_active_sessions (
        user_id,
        active_session_id,
        session_created_at,
        updated_at
    ) VALUES (
        v_user_id,
        v_session_id,
        v_session_created_at,
        now()
    )
    ON CONFLICT (user_id) DO UPDATE
    SET
        active_session_id = EXCLUDED.active_session_id,
        session_created_at = EXCLUDED.session_created_at,
        updated_at = EXCLUDED.updated_at
    WHERE EXCLUDED.session_created_at >= user_active_sessions.session_created_at
    RETURNING * INTO v_result;

    -- If the conditional UPSERT skipped updating because an older session arrived late,
    -- return the current authoritative active session row for this user.
    IF v_result IS NULL THEN
        SELECT * INTO v_result
        FROM public.user_active_sessions
        WHERE user_id = v_user_id;
    END IF;

    RETURN v_result;
END;
$$;

-- 6. RPC Grants & Revokes
REVOKE ALL ON FUNCTION public.register_active_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_active_session() TO authenticated;

-- 7. Supabase Realtime Publication (Idempotent Guard)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
    ) AND NOT EXISTS (
        SELECT 1 
        FROM pg_publication_rel pr
        JOIN pg_class c ON pr.prrelid = c.oid
        JOIN pg_publication p ON pr.prpubid = p.oid
        WHERE p.pubname = 'supabase_realtime'
          AND c.relname = 'user_active_sessions'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.user_active_sessions;
    END IF;
END $$;
