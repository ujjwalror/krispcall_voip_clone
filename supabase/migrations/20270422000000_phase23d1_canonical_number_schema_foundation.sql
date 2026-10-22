-- ==============================================================================
-- PHASE 23D.1: CANONICAL PHONE NUMBER SCHEMA & DOMAIN FOUNDATION
-- LOCAL MIGRATION ONLY — DO NOT APPLY TO REMOTE PRODUCTION DATABASE DIRECTLY
-- Additive schema foundation for canonical phone number lifecycle, ownership,
-- provider resource binding, capability progression, and safe historical retention.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. EXTEND public.phone_numbers WITH CANONICAL LIFECYCLE & ROUTING DIMENSIONS
-- ------------------------------------------------------------------------------
ALTER TABLE public.phone_numbers
ADD COLUMN IF NOT EXISTS ownership_state TEXT NULL,
ADD COLUMN IF NOT EXISTS service_state TEXT NULL,
ADD COLUMN IF NOT EXISTS provider_account_id UUID NULL REFERENCES public.telecom_provider_accounts(id) ON DELETE RESTRICT,
ADD COLUMN IF NOT EXISTS provider_resource_record_id UUID NULL REFERENCES public.telecom_provider_resource_records(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS capabilities_state JSONB NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS assignment_target_type TEXT NULL,
ADD COLUMN IF NOT EXISTS assignment_target_id UUID NULL,
ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS port_out_locked BOOLEAN NOT NULL DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS port_out_lock_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
ADD COLUMN IF NOT EXISTS port_out_lock_updated_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ NULL;

-- Safe domain CHECK constraints on public.phone_numbers
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_phone_numbers_canonical_ownership_state'
    ) THEN
        ALTER TABLE public.phone_numbers
        ADD CONSTRAINT chk_phone_numbers_canonical_ownership_state
        CHECK (ownership_state IS NULL OR ownership_state IN ('ACQUISITION_PENDING', 'OWNED', 'RELEASE_PENDING', 'RELEASED', 'PORTED_OUT'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_phone_numbers_canonical_service_state'
    ) THEN
        ALTER TABLE public.phone_numbers
        ADD CONSTRAINT chk_phone_numbers_canonical_service_state
        CHECK (service_state IS NULL OR service_state IN ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'UNAVAILABLE'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_phone_numbers_assignment_target_type'
    ) THEN
        ALTER TABLE public.phone_numbers
        ADD CONSTRAINT chk_phone_numbers_assignment_target_type
        CHECK (assignment_target_type IS NULL OR assignment_target_type IN ('USER', 'TEAM', 'QUEUE', 'IVR', 'WORKSPACE_MAIN', 'VOICEMAIL', 'UNASSIGNED_POOL'));
    END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 2. EXTEND public.organizations WITH PORT FREEZE CONTROLS
-- ------------------------------------------------------------------------------
ALTER TABLE public.organizations
ADD COLUMN IF NOT EXISTS port_freeze_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- ------------------------------------------------------------------------------
-- 3. EXTEND public.telecom_provider_resource_records WITH DOMAIN BINDING
-- ------------------------------------------------------------------------------
ALTER TABLE public.telecom_provider_resource_records
ADD COLUMN IF NOT EXISTS domain_phone_number_id UUID NULL REFERENCES public.phone_numbers(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ NULL;

-- ------------------------------------------------------------------------------
-- 4. EXTEND public.provider_number_operations (DURABLE PURCHASE SAGA)
-- ------------------------------------------------------------------------------
ALTER TABLE public.provider_number_operations
ADD COLUMN IF NOT EXISTS provider_account_id UUID NULL REFERENCES public.telecom_provider_accounts(id) ON DELETE RESTRICT,
ADD COLUMN IF NOT EXISTS outcome_certainty TEXT NULL,
ADD COLUMN IF NOT EXISTS reconciliation_state TEXT NULL,
ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_provider_num_ops_outcome_certainty'
    ) THEN
        ALTER TABLE public.provider_number_operations
        ADD CONSTRAINT chk_provider_num_ops_outcome_certainty
        CHECK (outcome_certainty IS NULL OR outcome_certainty IN ('CONFIRMED_SUCCESS', 'CONFIRMED_FAILURE', 'STILL_UNKNOWN', 'MANUAL_REVIEW_REQUIRED'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_provider_num_ops_reconciliation_state'
    ) THEN
        ALTER TABLE public.provider_number_operations
        ADD CONSTRAINT chk_provider_num_ops_reconciliation_state
        CHECK (reconciliation_state IS NULL OR reconciliation_state IN ('NONE', 'QUEUED', 'AUDITING', 'RESOLVED', 'MANUAL_INTERVENTION_REQUIRED'));
    END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 5. EXTEND public.number_release_operations (DURABLE RELEASE SAGA)
-- ------------------------------------------------------------------------------
ALTER TABLE public.number_release_operations
ADD COLUMN IF NOT EXISTS provider_account_id UUID NULL REFERENCES public.telecom_provider_accounts(id) ON DELETE RESTRICT,
ADD COLUMN IF NOT EXISTS provider_resource_record_id UUID NULL REFERENCES public.telecom_provider_resource_records(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS outcome_certainty TEXT NULL,
ADD COLUMN IF NOT EXISTS canonical_state TEXT NULL,
ADD COLUMN IF NOT EXISTS block_reason TEXT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_number_release_ops_outcome_certainty'
    ) THEN
        ALTER TABLE public.number_release_operations
        ADD CONSTRAINT chk_number_release_ops_outcome_certainty
        CHECK (outcome_certainty IS NULL OR outcome_certainty IN ('CONFIRMED_SUCCESS', 'CONFIRMED_FAILURE', 'STILL_UNKNOWN', 'MANUAL_REVIEW_REQUIRED'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_number_release_ops_canonical_state'
    ) THEN
        ALTER TABLE public.number_release_operations
        ADD CONSTRAINT chk_number_release_ops_canonical_state
        CHECK (canonical_state IS NULL OR canonical_state IN ('REQUESTED', 'VALIDATING', 'BLOCKED', 'AUTHORIZED', 'PROVIDER_RELEASE_PENDING', 'PROVIDER_OUTCOME_UNKNOWN', 'CONFIRMED', 'LOCAL_FINALIZATION', 'RELEASED', 'FAILED'));
    END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 6. CREATE public.phone_number_price_quotes (SEARCH & PRICING FOUNDATION)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.phone_number_price_quotes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'TWILIO',
    phone_number_e164 TEXT NOT NULL CHECK (phone_number_e164 ~ '^\+[1-9]\d{1,14}$'),
    number_type TEXT NOT NULL CHECK (number_type IN ('local', 'mobile', 'toll_free', 'national')),
    country_code VARCHAR(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    provider_setup_cost_minor INT NOT NULL DEFAULT 0 CHECK (provider_setup_cost_minor >= 0),
    provider_recurring_cost_minor INT NOT NULL DEFAULT 0 CHECK (provider_recurring_cost_minor >= 0),
    customer_setup_price_minor INT NOT NULL DEFAULT 0 CHECK (customer_setup_price_minor >= 0),
    customer_recurring_price_minor INT NOT NULL DEFAULT 0 CHECK (customer_recurring_price_minor >= 0),
    pricing_policy_id UUID NULL REFERENCES public.phone_number_pricing_policies(id) ON DELETE SET NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    search_token_signature TEXT NULL,
    reservation_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_price_quotes_expiration CHECK (expires_at > observed_at)
);

CREATE INDEX IF NOT EXISTS idx_phone_number_price_quotes_lookup
ON public.phone_number_price_quotes (organization_id, phone_number_e164, expires_at);

-- ------------------------------------------------------------------------------
-- 7. CREATE public.phone_number_lifecycle_events (IMMUTABLE AUDIT TRAIL)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.phone_number_lifecycle_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    phone_number_id UUID NOT NULL REFERENCES public.phone_numbers(id) ON DELETE RESTRICT,
    phone_number_e164 TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (
        event_type IN (
            'PURCHASE_REQUESTED',
            'PURCHASE_CONFIRMED',
            'PURCHASE_FAILED',
            'PURCHASE_RECONCILED',
            'ASSIGNED',
            'UNASSIGNED',
            'ROUTING_CHANGED',
            'SUSPENDED',
            'REACTIVATED',
            'RELEASE_REQUESTED',
            'RELEASE_BLOCKED',
            'RELEASE_CONFIRMED',
            'PORT_IN_REQUESTED',
            'PORT_IN_COMPLETED',
            'PORT_IN_FAILED',
            'PORT_OUT_REQUESTED',
            'PORT_OUT_AUTHORIZED',
            'PORT_OUT_COMPLETED',
            'PORT_FREEZE_CHANGED',
            'COMPLIANCE_CHANGED'
        )
    ),
    actor_type TEXT NOT NULL CHECK (actor_type IN ('USER', 'SYSTEM', 'CARRIER_WEBHOOK', 'CRON_WORKER')),
    actor_id UUID NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_phone_number_lifecycle_events_phone
ON public.phone_number_lifecycle_events (phone_number_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_phone_number_lifecycle_events_org
ON public.phone_number_lifecycle_events (organization_id, created_at DESC);

-- ------------------------------------------------------------------------------
-- 8. CANONICAL INDEXES FOR QUERY OPTIMIZATION & INVARIANT ENFORCEMENT
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_phone_numbers_canonical_states
ON public.phone_numbers (organization_id, ownership_state, service_state);

CREATE INDEX IF NOT EXISTS idx_phone_numbers_provider_account
ON public.phone_numbers (provider_account_id);

CREATE INDEX IF NOT EXISTS idx_phone_numbers_provider_resource
ON public.phone_numbers (provider_resource_record_id);

CREATE INDEX IF NOT EXISTS idx_telecom_provider_resources_domain_phone
ON public.telecom_provider_resource_records (domain_phone_number_id);

-- Enforce at most one active canonical owner per E.164 (permitting unlimited historical tombstones)
CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_numbers_canonical_active_ownership
ON public.phone_numbers (phone_number)
WHERE ownership_state IN ('ACQUISITION_PENDING', 'OWNED', 'RELEASE_PENDING');

-- ------------------------------------------------------------------------------
-- 9. ROW-LEVEL SECURITY & ACCESS PRIVILEGES
-- ------------------------------------------------------------------------------
ALTER TABLE public.phone_number_price_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.phone_number_lifecycle_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.phone_number_price_quotes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.phone_number_lifecycle_events FROM PUBLIC, anon, authenticated;

GRANT ALL ON public.phone_number_price_quotes TO service_role;
GRANT ALL ON public.phone_number_lifecycle_events TO service_role;

-- Allow authenticated users to view price quotes and lifecycle events within their organization
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'authenticated_price_quotes_org_select' AND tablename = 'phone_number_price_quotes'
    ) THEN
        CREATE POLICY authenticated_price_quotes_org_select ON public.phone_number_price_quotes
        FOR SELECT TO authenticated
        USING (organization_id = (SELECT organization_id FROM public.profiles WHERE id = auth.uid()));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'authenticated_lifecycle_events_org_select' AND tablename = 'phone_number_lifecycle_events'
    ) THEN
        CREATE POLICY authenticated_lifecycle_events_org_select ON public.phone_number_lifecycle_events
        FOR SELECT TO authenticated
        USING (organization_id = (SELECT organization_id FROM public.profiles WHERE id = auth.uid()));
    END IF;
END $$;
