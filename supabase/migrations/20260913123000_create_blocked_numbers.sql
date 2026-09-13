-- ====================================================================
-- MIGRATION: CREATE BLOCKED NUMBERS TABLE & POLICIES
-- Date: 2026-09-13
-- Organization-level phone blocklist table with RLS security
-- ====================================================================

-- 1. Create public.blocked_numbers table
CREATE TABLE IF NOT EXISTS public.blocked_numbers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    phone_number TEXT NOT NULL,
    normalized_phone TEXT NOT NULL,
    contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
    reason TEXT,
    created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT blocked_numbers_org_phone_unique UNIQUE (organization_id, normalized_phone)
);

-- 2. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_blocked_numbers_org_phone ON public.blocked_numbers(organization_id, normalized_phone);
CREATE INDEX IF NOT EXISTS idx_blocked_numbers_contact_id ON public.blocked_numbers(contact_id);

-- 3. Enable RLS
ALTER TABLE public.blocked_numbers ENABLE ROW LEVEL SECURITY;

-- 4. Row Level Security Policies
DROP POLICY IF EXISTS "Users can view blocked numbers of their organization" ON public.blocked_numbers;
CREATE POLICY "Users can view blocked numbers of their organization"
ON public.blocked_numbers FOR SELECT
USING (
    organization_id IN (
        SELECT organization_id FROM public.profiles WHERE id = auth.uid()
    )
);

DROP POLICY IF EXISTS "Users can insert blocked numbers for their organization" ON public.blocked_numbers;
CREATE POLICY "Users can insert blocked numbers for their organization"
ON public.blocked_numbers FOR INSERT
WITH CHECK (
    organization_id IN (
        SELECT organization_id FROM public.profiles WHERE id = auth.uid()
    )
);

DROP POLICY IF EXISTS "Users can delete blocked numbers of their organization" ON public.blocked_numbers;
CREATE POLICY "Users can delete blocked numbers of their organization"
ON public.blocked_numbers FOR DELETE
USING (
    organization_id IN (
        SELECT organization_id FROM public.profiles WHERE id = auth.uid()
    )
);

DROP POLICY IF EXISTS "Users can update blocked numbers of their organization" ON public.blocked_numbers;
CREATE POLICY "Users can update blocked numbers of their organization"
ON public.blocked_numbers FOR UPDATE
USING (
    organization_id IN (
        SELECT organization_id FROM public.profiles WHERE id = auth.uid()
    )
);

-- 5. Expand calls.status check constraint to include 'blocked'
DO $$
BEGIN
    ALTER TABLE public.calls DROP CONSTRAINT IF EXISTS calls_status_check;
    ALTER TABLE public.calls ADD CONSTRAINT calls_status_check CHECK (
        status IN ('queued', 'initiated', 'ringing', 'in-progress', 'completed', 'busy', 'failed', 'no-answer', 'canceled', 'missed', 'blocked')
    );
EXCEPTION WHEN OTHERS THEN
    NULL;
END $$;
