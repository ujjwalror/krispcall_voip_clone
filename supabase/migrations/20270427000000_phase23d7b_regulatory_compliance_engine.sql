-- ==============================================================================
-- PHASE 23D.7B: PROVIDER-NEUTRAL REGULATORY COMPLIANCE ENGINE FOUNDATION
-- Additive, Non-Destructive Migration
-- Conforms strictly to Phase 23D.7A research and Phase 23C frozen architecture
-- ==============================================================================

-- 1. Regulatory Subjects (Decoupled Legal Entities / Verified Persons)
CREATE TABLE IF NOT EXISTS public.regulatory_subjects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    subject_type TEXT NOT NULL CHECK (subject_type IN ('business', 'individual')),
    legal_name TEXT NOT NULL,
    trade_name TEXT NULL,
    first_name TEXT NULL,
    last_name TEXT NULL,
    email TEXT NOT NULL,
    phone_number TEXT NULL,
    registration_number_encrypted TEXT NULL,
    tax_id_encrypted TEXT NULL,
    address_street TEXT NULL,
    address_extended TEXT NULL,
    address_city TEXT NULL,
    address_region TEXT NULL,
    address_postal_code TEXT NULL,
    address_country_code VARCHAR(2) NOT NULL,
    encryption_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by UUID NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reg_subjects_org_id ON public.regulatory_subjects(organization_id);
CREATE INDEX IF NOT EXISTS idx_reg_subjects_country ON public.regulatory_subjects(organization_id, address_country_code);

-- 2. Compliance Requirement Snapshots (Extend existing table if present, or create)
CREATE TABLE IF NOT EXISTS public.compliance_requirement_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    compliance_profile_id UUID NULL,
    provider TEXT NOT NULL DEFAULT 'twilio',
    provider_regulation_id TEXT NULL,
    country_code VARCHAR(2) NOT NULL,
    number_type TEXT NOT NULL,
    end_user_type TEXT NOT NULL CHECK (end_user_type IN ('business', 'individual')),
    requirement_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    retrieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.compliance_requirement_snapshots
ADD COLUMN IF NOT EXISTS constraints_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS fingerprint TEXT NULL,
ADD COLUMN IF NOT EXISTS canonical_number_type TEXT NULL;

DO $$
BEGIN
    ALTER TABLE public.compliance_requirement_snapshots ALTER COLUMN compliance_profile_id DROP NOT NULL;
EXCEPTION
    WHEN OTHERS THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_comp_req_snapshots_lookup 
ON public.compliance_requirement_snapshots(country_code, number_type, end_user_type, retrieved_at DESC);

-- Immutable Requirement Snapshots: append-only historical records
CREATE OR REPLACE FUNCTION prevent_snapshot_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'COMPLIANCE_REQUIREMENT_SNAPSHOT_IMMUTABLE: Requirement snapshots are append-only historical records and cannot be modified.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_snapshot_mutation ON public.compliance_requirement_snapshots;
CREATE TRIGGER trg_prevent_snapshot_mutation
BEFORE UPDATE OR DELETE ON public.compliance_requirement_snapshots
FOR EACH ROW EXECUTE FUNCTION prevent_snapshot_mutation();

-- 3. Canonical Compliance Cases (Independent of Provider Bundles)
CREATE TABLE IF NOT EXISTS public.compliance_cases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    regulatory_subject_id UUID NOT NULL REFERENCES public.regulatory_subjects(id) ON DELETE CASCADE,
    requirement_snapshot_id UUID NULL REFERENCES public.compliance_requirement_snapshots(id) ON DELETE SET NULL,
    provider TEXT NOT NULL DEFAULT 'TWILIO',
    provider_account_id UUID NULL REFERENCES public.telecom_provider_accounts(id) ON DELETE RESTRICT,
    country_code VARCHAR(2) NOT NULL,
    number_type TEXT NOT NULL CHECK (number_type IN ('local', 'national', 'mobile', 'toll_free')),
    subject_type TEXT NOT NULL CHECK (subject_type IN ('business', 'individual')),
    canonical_status TEXT NOT NULL CHECK (canonical_status IN (
        'NOT_REQUIRED',
        'REQUIREMENTS_DISCOVERED',
        'INCOMPLETE',
        'READY_FOR_SUBMISSION',
        'SUBMISSION_PENDING',
        'SUBMITTED',
        'UNDER_REVIEW',
        'APPROVED',
        'REJECTED',
        'UPDATE_REQUIRED',
        'EXPIRED',
        'UNKNOWN',
        'MANUAL_REVIEW_REQUIRED'
    )),
    raw_provider_status TEXT NULL,
    rejection_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    valid_until TIMESTAMPTZ NULL,
    submitted_at TIMESTAMPTZ NULL,
    approved_at TIMESTAMPTZ NULL,
    reconciled_at TIMESTAMPTZ NULL,
    idempotency_key TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compliance_cases_org_status 
ON public.compliance_cases(organization_id, canonical_status);

CREATE INDEX IF NOT EXISTS idx_compliance_cases_subject 
ON public.compliance_cases(regulatory_subject_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_cases_org_idempotency
ON public.compliance_cases(organization_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;

-- 4. Canonical Compliance Evidence (Secure Metadata, Zero Plaintext Documents)
CREATE TABLE IF NOT EXISTS public.compliance_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    regulatory_subject_id UUID NOT NULL REFERENCES public.regulatory_subjects(id) ON DELETE CASCADE,
    compliance_case_id UUID NULL REFERENCES public.compliance_cases(id) ON DELETE SET NULL,
    evidence_type TEXT NOT NULL,
    storage_object_path TEXT NOT NULL,
    original_filename_sanitized TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    sha256_hash VARCHAR(64) NOT NULL,
    status TEXT NOT NULL DEFAULT 'VALIDATED' CHECK (status IN ('UPLOADED', 'VALIDATED', 'SUBMITTED', 'REJECTED', 'EXPIRED', 'DELETED')),
    valid_until TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comp_evidence_org_subject 
ON public.compliance_evidence(organization_id, regulatory_subject_id);

CREATE INDEX IF NOT EXISTS idx_comp_evidence_case 
ON public.compliance_evidence(compliance_case_id);

-- 5. Phone Number Compliance Bindings (Durable Link Between Number UUID & Compliance Case)
CREATE TABLE IF NOT EXISTS public.number_compliance_bindings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    phone_number_id UUID NOT NULL REFERENCES public.phone_numbers(id) ON DELETE CASCADE,
    compliance_case_id UUID NOT NULL REFERENCES public.compliance_cases(id) ON DELETE RESTRICT,
    provider_compliance_resource_id UUID NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'REVOKED')),
    bound_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_number_comp_bindings_org_num 
ON public.number_compliance_bindings(organization_id, phone_number_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_number_compliance_binding 
ON public.number_compliance_bindings(phone_number_id) 
WHERE status = 'ACTIVE';

-- 6. Extend Provider Compliance Operations for Case and Account Scoping
CREATE TABLE IF NOT EXISTS public.provider_compliance_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    compliance_profile_id UUID NULL,
    provider TEXT NOT NULL DEFAULT 'twilio',
    operation_type TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INT NOT NULL DEFAULT 0,
    provider_resource_type TEXT NULL,
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

ALTER TABLE public.provider_compliance_operations
ADD COLUMN IF NOT EXISTS compliance_case_id UUID NULL REFERENCES public.compliance_cases(id) ON DELETE CASCADE,
ADD COLUMN IF NOT EXISTS provider_account_id UUID NULL REFERENCES public.telecom_provider_accounts(id) ON DELETE RESTRICT;

-- 7. Extend Provider Resource Mappings with Account & Local Linkage
CREATE TABLE IF NOT EXISTS public.provider_resource_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    compliance_profile_id UUID NULL,
    provider TEXT NOT NULL DEFAULT 'twilio',
    resource_type TEXT NOT NULL,
    provider_resource_id TEXT NOT NULL,
    country_code VARCHAR(2) NOT NULL,
    number_type TEXT NOT NULL,
    end_user_type TEXT NOT NULL,
    provider_regulation_id TEXT NULL,
    provider_status TEXT NOT NULL DEFAULT 'draft',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_entity_id TEXT NOT NULL DEFAULT 'primary',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.provider_resource_mappings
ADD COLUMN IF NOT EXISTS provider_account_id UUID NULL REFERENCES public.telecom_provider_accounts(id) ON DELETE RESTRICT,
ADD COLUMN IF NOT EXISTS compliance_case_id UUID NULL REFERENCES public.compliance_cases(id) ON DELETE CASCADE,
ADD COLUMN IF NOT EXISTS local_resource_type TEXT NULL,
ADD COLUMN IF NOT EXISTS local_resource_id UUID NULL;

CREATE INDEX IF NOT EXISTS idx_provider_mappings_acc 
ON public.provider_resource_mappings(organization_id, provider_account_id, provider_resource_id);

-- 8. Compliance Lifecycle Events Audit Table
CREATE TABLE IF NOT EXISTS public.compliance_lifecycle_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    regulatory_subject_id UUID NULL REFERENCES public.regulatory_subjects(id) ON DELETE SET NULL,
    compliance_case_id UUID NULL REFERENCES public.compliance_cases(id) ON DELETE SET NULL,
    phone_number_id UUID NULL REFERENCES public.phone_numbers(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    actor_id UUID NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comp_lifecycle_events_case 
ON public.compliance_lifecycle_events(organization_id, compliance_case_id, created_at DESC);

-- 9. Row Level Security & Server Authority
ALTER TABLE public.regulatory_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.number_compliance_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_lifecycle_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON public.regulatory_subjects FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON public.compliance_cases FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON public.compliance_evidence FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON public.number_compliance_bindings FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON public.compliance_lifecycle_events FROM PUBLIC, anon, authenticated;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT ALL ON public.regulatory_subjects TO service_role;
        GRANT ALL ON public.compliance_cases TO service_role;
        GRANT ALL ON public.compliance_evidence TO service_role;
        GRANT ALL ON public.number_compliance_bindings TO service_role;
        GRANT ALL ON public.compliance_lifecycle_events TO service_role;
    END IF;
END $$;
