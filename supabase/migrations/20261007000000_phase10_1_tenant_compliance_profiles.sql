-- ====================================================================
-- MIGRATION: PHASE 10.1 TENANT COMPLIANCE PROFILE FOUNDATION
-- Date: 2026-10-07
-- Establishes durable, multi-tenant compliance profile foundation,
-- requirement snapshot tracking, dynamic field value storage, and strict least-privilege security.
-- ====================================================================

-- 1. Create public.organization_compliance_profiles table
CREATE TABLE IF NOT EXISTS public.organization_compliance_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    end_user_type TEXT NOT NULL CHECK (end_user_type IN ('business', 'individual')),
    country_code VARCHAR(2) NOT NULL,
    legal_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'information_required', 'ready_for_submission')),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for organization lookup
CREATE INDEX IF NOT EXISTS idx_org_compliance_profiles_org_id 
ON public.organization_compliance_profiles(organization_id);

-- Updated_at trigger
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'update_org_compliance_profiles_updated_at'
    ) THEN
        CREATE TRIGGER update_org_compliance_profiles_updated_at
            BEFORE UPDATE ON public.organization_compliance_profiles
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- 2. Create public.compliance_requirement_snapshots table (Server-Authoritative Append-Only)
CREATE TABLE IF NOT EXISTS public.compliance_requirement_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    compliance_profile_id UUID NOT NULL REFERENCES public.organization_compliance_profiles(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'twilio',
    provider_regulation_id TEXT NULL,
    country_code VARCHAR(2) NOT NULL,
    number_type TEXT NOT NULL CHECK (number_type IN ('local', 'mobile', 'toll_free')),
    end_user_type TEXT NOT NULL CHECK (end_user_type IN ('business', 'individual')),
    requirement_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    retrieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for compliance profile lookup
CREATE INDEX IF NOT EXISTS idx_compliance_req_snapshots_profile_id 
ON public.compliance_requirement_snapshots(compliance_profile_id);

-- 3. Create public.compliance_field_values table
CREATE TABLE IF NOT EXISTS public.compliance_field_values (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    compliance_profile_id UUID NOT NULL REFERENCES public.organization_compliance_profiles(id) ON DELETE CASCADE,
    requirement_key TEXT NOT NULL,
    field_name TEXT NOT NULL,
    field_value TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_compliance_field_key_name UNIQUE (compliance_profile_id, requirement_key, field_name)
);

-- Index for compliance profile lookup
CREATE INDEX IF NOT EXISTS idx_compliance_field_values_profile_id 
ON public.compliance_field_values(compliance_profile_id);

-- Updated_at trigger
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'update_compliance_field_values_updated_at'
    ) THEN
        CREATE TRIGGER update_compliance_field_values_updated_at
            BEFORE UPDATE ON public.compliance_field_values
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- 4. Enable Row Level Security (RLS) on all compliance tables
ALTER TABLE public.organization_compliance_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_requirement_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_field_values ENABLE ROW LEVEL SECURITY;

-- 5. Revoke least privilege table mutations from public/anon/authenticated roles
-- All mutations pass through application APIs using service_role authority
REVOKE ALL ON public.organization_compliance_profiles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.compliance_requirement_snapshots FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.compliance_field_values FROM PUBLIC, anon, authenticated;

-- Grant SELECT only to authenticated users (evaluated by RLS policies for owner/admin)
GRANT SELECT ON public.organization_compliance_profiles TO authenticated;
GRANT SELECT ON public.compliance_requirement_snapshots TO authenticated;
GRANT SELECT ON public.compliance_field_values TO authenticated;

-- Grant FULL permissions to service_role (used exclusively by backend server APIs)
GRANT ALL ON public.organization_compliance_profiles TO service_role;
GRANT ALL ON public.compliance_requirement_snapshots TO service_role;
GRANT ALL ON public.compliance_field_values TO service_role;

-- 6. Create SELECT-ONLY RLS Policies for authenticated Owner and Admin roles
-- Read-only policy for organization_compliance_profiles
DO $$
BEGIN
    DROP POLICY IF EXISTS "Owner and Admin read compliance profiles" ON public.organization_compliance_profiles;
    CREATE POLICY "Owner and Admin read compliance profiles"
    ON public.organization_compliance_profiles
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.organization_id = organization_compliance_profiles.organization_id
              AND p.role IN ('owner', 'admin')
        )
    );
END $$;

-- Read-only policy for compliance_requirement_snapshots (No INSERT/UPDATE/DELETE policy for clients)
DO $$
BEGIN
    DROP POLICY IF EXISTS "Owner and Admin read requirement snapshots" ON public.compliance_requirement_snapshots;
    CREATE POLICY "Owner and Admin read requirement snapshots"
    ON public.compliance_requirement_snapshots
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.organization_compliance_profiles ocp
            JOIN public.profiles p ON p.organization_id = ocp.organization_id
            WHERE ocp.id = compliance_requirement_snapshots.compliance_profile_id
              AND p.id = auth.uid()
              AND p.role IN ('owner', 'admin')
        )
    );
END $$;

-- Read-only policy for compliance_field_values (No INSERT/UPDATE/DELETE policy for clients)
DO $$
BEGIN
    DROP POLICY IF EXISTS "Owner and Admin read compliance field values" ON public.compliance_field_values;
    CREATE POLICY "Owner and Admin read compliance field values"
    ON public.compliance_field_values
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.organization_compliance_profiles ocp
            JOIN public.profiles p ON p.organization_id = ocp.organization_id
            WHERE ocp.id = compliance_field_values.compliance_profile_id
              AND p.id = auth.uid()
              AND p.role IN ('owner', 'admin')
        )
    );
END $$;
