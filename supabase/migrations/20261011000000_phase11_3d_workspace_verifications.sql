-- ====================================================================
-- MIGRATION: PHASE 11.3D ACCOUNT / WORKSPACE VERIFICATION FOUNDATION
-- Date: 2026-10-11
-- Establishes durable workspace identity verification state tracking,
-- vendor session metadata, and strict least-privilege security.
-- ====================================================================

-- 1. Create public.organization_workspace_verifications table
CREATE TABLE IF NOT EXISTS public.organization_workspace_verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    verification_type TEXT NOT NULL DEFAULT 'business' CHECK (verification_type IN ('business', 'individual')),
    status TEXT NOT NULL DEFAULT 'not_started' CHECK (
        status IN ('not_started', 'verification_required', 'under_review', 'verified', 'action_required', 'rejected')
    ),
    vendor_provider TEXT NULL,
    vendor_session_id TEXT NULL,
    vendor_reference_id TEXT NULL,
    submitted_at TIMESTAMPTZ NULL,
    verified_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_org_workspace_verifications_org UNIQUE (organization_id)
);

-- Index for organization lookup
CREATE INDEX IF NOT EXISTS idx_org_workspace_verifications_org_id
ON public.organization_workspace_verifications(organization_id);

-- Trigger for updated_at column
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'update_org_workspace_verifications_updated_at'
    ) THEN
        CREATE TRIGGER update_org_workspace_verifications_updated_at
            BEFORE UPDATE ON public.organization_workspace_verifications
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- 2. Enable Row Level Security (RLS) - Server-Authoritative Table
ALTER TABLE public.organization_workspace_verifications ENABLE ROW LEVEL SECURITY;

-- 3. Revoke direct table privileges from anon & authenticated client roles
REVOKE ALL ON public.organization_workspace_verifications FROM authenticated, anon;

-- 4. Grant backend service-role full administrative management access
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_workspace_verifications TO service_role;
