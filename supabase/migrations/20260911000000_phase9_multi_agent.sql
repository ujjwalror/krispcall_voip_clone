-- ====================================================================
-- PHASE 9 MIGRATION: MULTI-AGENT WORKSPACE & INBOUND CALL ROUTING
-- ====================================================================

-- 1. Add extension, availability_status, and last_seen_at columns to public.profiles
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'extension'
    ) THEN
        ALTER TABLE public.profiles ADD COLUMN extension TEXT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'availability_status'
    ) THEN
        ALTER TABLE public.profiles ADD COLUMN availability_status TEXT DEFAULT 'available';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'last_seen_at'
    ) THEN
        ALTER TABLE public.profiles ADD COLUMN last_seen_at TIMESTAMPTZ DEFAULT NOW();
    END IF;
END $$;

-- 2. Update role check constraint on public.profiles to allow ('admin', 'manager', 'agent')
DO $$
BEGIN
    ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (role IN ('admin', 'manager', 'agent'));
EXCEPTION
    WHEN OTHERS THEN NULL;
END $$;

-- 3. Populate twilio_identity for any profile where it is null
UPDATE public.profiles
SET twilio_identity = 'agent_' || REPLACE(id::text, '-', '')
WHERE twilio_identity IS NULL;

-- 4. Add routing_strategy and last_routed_user_id columns to public.organizations
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'routing_strategy'
    ) THEN
        ALTER TABLE public.organizations ADD COLUMN routing_strategy TEXT DEFAULT 'ring_all';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'last_routed_user_id'
    ) THEN
        ALTER TABLE public.organizations ADD COLUMN last_routed_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
    END IF;
END $$;

-- 5. Add database indexes for quick presence & routing queries
CREATE INDEX IF NOT EXISTS idx_profiles_presence ON public.profiles(organization_id, active, availability_status, last_seen_at);
