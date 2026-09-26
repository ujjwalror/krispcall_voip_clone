-- ====================================================================
-- MIGRATION: PHASE 10.2B.1 PROVIDER SUBMISSION FOUNDATION
-- Date: 2026-10-09
-- Establishes durable provider operation ledger, idempotency constraints,
-- provider resource mappings, and strict server-only RLS security.
-- DO NOT EXECUTE REMOTELY YET — Subject to manual go/no-go review.
-- ====================================================================

-- 1. Create public.provider_compliance_operations table
CREATE TABLE IF NOT EXISTS public.provider_compliance_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    compliance_profile_id UUID NOT NULL REFERENCES public.organization_compliance_profiles(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'twilio',
    operation_type TEXT NOT NULL CHECK (
        operation_type IN (
            'create_address',
            'create_end_user',
            'create_supporting_document',
            'create_bundle',
            'assign_item_to_bundle',
            'request_bundle_evaluation',
            'submit_bundle'
        )
    ),
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN (
            'pending',
            'in_progress',
            'succeeded',
            'failed',
            'reconciliation_required'
        )
    ),
    attempt_count INT NOT NULL DEFAULT 0,
    provider_resource_type TEXT NULL CHECK (
        provider_resource_type IS NULL OR provider_resource_type IN (
            'address',
            'end_user',
            'supporting_document',
            'bundle',
            'item_assignment'
        )
    ),
    provider_resource_id TEXT NULL,
    request_fingerprint TEXT NOT NULL,
    last_error_code TEXT NULL,
    last_error_message_sanitized TEXT NULL,
    started_at TIMESTAMPTZ NULL,
    completed_at TIMESTAMPTZ NULL,
    last_reconciled_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_org_idempotency_key UNIQUE (organization_id, idempotency_key)
);

-- Indexes for provider compliance operations lookup
CREATE INDEX IF NOT EXISTS idx_provider_ops_org_id 
ON public.provider_compliance_operations(organization_id);

CREATE INDEX IF NOT EXISTS idx_provider_ops_profile_id 
ON public.provider_compliance_operations(compliance_profile_id);

CREATE INDEX IF NOT EXISTS idx_provider_ops_status 
ON public.provider_compliance_operations(status);

-- Updated_at trigger for provider_compliance_operations
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'update_provider_compliance_ops_updated_at'
    ) THEN
        CREATE TRIGGER update_provider_compliance_ops_updated_at
            BEFORE UPDATE ON public.provider_compliance_operations
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;


-- 2. Create public.provider_resource_mappings table
CREATE TABLE IF NOT EXISTS public.provider_resource_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    compliance_profile_id UUID NOT NULL REFERENCES public.organization_compliance_profiles(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'twilio',
    resource_type TEXT NOT NULL CHECK (
        resource_type IN (
            'address',
            'end_user',
            'supporting_document',
            'bundle',
            'item_assignment'
        )
    ),
    provider_resource_id TEXT NOT NULL,
    country_code VARCHAR(2) NOT NULL,
    number_type TEXT NOT NULL CHECK (number_type IN ('local', 'mobile', 'toll_free')),
    end_user_type TEXT NOT NULL CHECK (end_user_type IN ('business', 'individual')),
    provider_regulation_id TEXT NULL,
    provider_status TEXT NOT NULL DEFAULT 'draft',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_org_provider_resource UNIQUE (organization_id, provider, resource_type, provider_resource_id),
    CONSTRAINT unique_org_profile_resource_type UNIQUE (organization_id, compliance_profile_id, provider, resource_type, country_code, number_type, end_user_type)
);

-- Indexes for provider resource mappings
CREATE INDEX IF NOT EXISTS idx_provider_mappings_org_id 
ON public.provider_resource_mappings(organization_id);

CREATE INDEX IF NOT EXISTS idx_provider_mappings_profile_id 
ON public.provider_resource_mappings(compliance_profile_id);

-- Updated_at trigger for provider_resource_mappings
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'update_provider_resource_mappings_updated_at'
    ) THEN
        CREATE TRIGGER update_provider_resource_mappings_updated_at
            BEFORE UPDATE ON public.provider_resource_mappings
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;


-- 3. Enable Row Level Security (RLS) on both tables
ALTER TABLE public.provider_compliance_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_resource_mappings ENABLE ROW LEVEL SECURITY;


-- 4. STRICT SERVER-ONLY PERMISSIONS MODEL:
-- Revoke ALL privileges from public/anon/authenticated roles.
-- Direct browser queries/mutations are forbidden. No client SELECT policies are created.
-- All database operations pass exclusively through authenticated server APIs using service_role authority.
REVOKE ALL ON public.provider_compliance_operations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.provider_resource_mappings FROM PUBLIC, anon, authenticated;

-- Grant ALL permissions strictly to service_role (used exclusively by server-side APIs)
GRANT ALL ON public.provider_compliance_operations TO service_role;
GRANT ALL ON public.provider_resource_mappings TO service_role;
