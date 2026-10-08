-- ====================================================================
-- VOIP HUB — PHASE 19B MIGRATION
-- CALL QUEUE ENGINE & LIVE QUEUE DASHBOARD SCHEMA
-- ====================================================================

-- 1. Create public.call_queues table
CREATE TABLE IF NOT EXISTS public.call_queues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    strategy TEXT NOT NULL DEFAULT 'fifo',
    max_wait_seconds INTEGER NOT NULL DEFAULT 300,
    ring_timeout_seconds INTEGER NOT NULL DEFAULT 20,
    greeting_type TEXT NOT NULL DEFAULT 'tts',
    greeting_text TEXT NOT NULL DEFAULT 'Thank you for calling. Please hold while we connect you to an available agent.',
    greeting_audio_url TEXT NULL,
    fallback_destination_type TEXT NOT NULL DEFAULT 'voicemail',
    fallback_destination_id TEXT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Constraints for call_queues
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_call_queues_strategy') THEN
        ALTER TABLE public.call_queues
            ADD CONSTRAINT chk_call_queues_strategy
            CHECK (strategy IN ('fifo', 'round_robin', 'longest_idle'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_call_queues_greeting_type') THEN
        ALTER TABLE public.call_queues
            ADD CONSTRAINT chk_call_queues_greeting_type
            CHECK (greeting_type IN ('tts', 'audio_url'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_call_queues_fallback_dest_type') THEN
        ALTER TABLE public.call_queues
            ADD CONSTRAINT chk_call_queues_fallback_dest_type
            CHECK (fallback_destination_type IN ('user', 'ivr', 'voicemail', 'hangup'));
    END IF;
END $$;

-- Indexes for call_queues
CREATE INDEX IF NOT EXISTS idx_call_queues_org ON public.call_queues (organization_id, enabled);


-- 2. Create public.call_queue_members table
CREATE TABLE IF NOT EXISTS public.call_queue_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    queue_id UUID NOT NULL REFERENCES public.call_queues(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    priority INTEGER NOT NULL DEFAULT 1,
    last_offered_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_call_queue_members_queue_user UNIQUE (queue_id, user_id)
);

-- Indexes for call_queue_members
CREATE INDEX IF NOT EXISTS idx_call_queue_members_queue ON public.call_queue_members (queue_id, enabled);
CREATE INDEX IF NOT EXISTS idx_call_queue_members_user ON public.call_queue_members (user_id, organization_id);


-- 3. Create public.call_queue_entries table
CREATE TABLE IF NOT EXISTS public.call_queue_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    queue_id UUID NOT NULL REFERENCES public.call_queues(id) ON DELETE CASCADE,
    call_id UUID NULL REFERENCES public.calls(id) ON DELETE SET NULL,
    provider_call_sid TEXT NOT NULL,
    caller_phone_number TEXT NOT NULL DEFAULT 'Anonymous',
    status TEXT NOT NULL DEFAULT 'waiting',
    assigned_agent_id UUID NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
    entered_at TIMESTAMPTZ DEFAULT NOW(),
    offered_at TIMESTAMPTZ NULL,
    connected_at TIMESTAMPTZ NULL,
    completed_at TIMESTAMPTZ NULL,
    abandoned_at TIMESTAMPTZ NULL,
    timed_out_at TIMESTAMPTZ NULL,
    wait_duration_seconds INTEGER DEFAULT 0,
    talk_duration_seconds INTEGER DEFAULT 0,
    attempt_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Constraint for queue entry status
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_call_queue_entries_status') THEN
        ALTER TABLE public.call_queue_entries
            ADD CONSTRAINT chk_call_queue_entries_status
            CHECK (status IN ('waiting', 'offering', 'connected', 'completed', 'abandoned', 'timed_out', 'failed'));
    END IF;
END $$;

-- Indexes for call_queue_entries
CREATE INDEX IF NOT EXISTS idx_call_queue_entries_queue_status ON public.call_queue_entries (queue_id, status);
CREATE INDEX IF NOT EXISTS idx_call_queue_entries_org_status ON public.call_queue_entries (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_call_queue_entries_call_sid ON public.call_queue_entries (provider_call_sid);
CREATE INDEX IF NOT EXISTS idx_call_queue_entries_agent ON public.call_queue_entries (assigned_agent_id, status);


-- 4. Enable Row-Level Security (RLS)
ALTER TABLE public.call_queues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_queue_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_queue_entries ENABLE ROW LEVEL SECURITY;


-- 5. RLS Policies for call_queues
DROP POLICY IF EXISTS call_queues_select_tenant ON public.call_queues;
CREATE POLICY call_queues_select_tenant ON public.call_queues
    FOR SELECT TO authenticated
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles WHERE id = auth.uid()
        )
    );

DROP POLICY IF EXISTS call_queues_insert_admin ON public.call_queues;
CREATE POLICY call_queues_insert_admin ON public.call_queues
    FOR INSERT TO authenticated
    WITH CHECK (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
    );

DROP POLICY IF EXISTS call_queues_update_admin ON public.call_queues;
CREATE POLICY call_queues_update_admin ON public.call_queues
    FOR UPDATE TO authenticated
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
    )
    WITH CHECK (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
    );

DROP POLICY IF EXISTS call_queues_delete_admin ON public.call_queues;
CREATE POLICY call_queues_delete_admin ON public.call_queues
    FOR DELETE TO authenticated
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
    );


-- 6. RLS Policies for call_queue_members
DROP POLICY IF EXISTS call_queue_members_select_tenant ON public.call_queue_members;
CREATE POLICY call_queue_members_select_tenant ON public.call_queue_members
    FOR SELECT TO authenticated
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles WHERE id = auth.uid()
        )
    );

DROP POLICY IF EXISTS call_queue_members_insert_admin ON public.call_queue_members;
CREATE POLICY call_queue_members_insert_admin ON public.call_queue_members
    FOR INSERT TO authenticated
    WITH CHECK (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
    );

DROP POLICY IF EXISTS call_queue_members_update_admin ON public.call_queue_members;
CREATE POLICY call_queue_members_update_admin ON public.call_queue_members
    FOR UPDATE TO authenticated
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
    )
    WITH CHECK (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
    );

DROP POLICY IF EXISTS call_queue_members_delete_admin ON public.call_queue_members;
CREATE POLICY call_queue_members_delete_admin ON public.call_queue_members
    FOR DELETE TO authenticated
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
    );


-- 7. RLS Policies for call_queue_entries
DROP POLICY IF EXISTS call_queue_entries_select_tenant ON public.call_queue_entries;
CREATE POLICY call_queue_entries_select_tenant ON public.call_queue_entries
    FOR SELECT TO authenticated
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles WHERE id = auth.uid()
        )
    );
