-- ====================================================================
-- MIGRATION: PHASE 12.2 DURABLE PURCHASE OPERATION LEDGER
-- Date: 2026-11-02
-- Establishes provider_number_operations ledger table, global active E.164
-- purchase locks, request fingerprinting constraints, atomic RPC functions,
-- lifecycle-aware phone number ownership protection, and server-only security.
-- DO NOT EXECUTE REMOTELY AUTOMATICALLY — Subject to manual user review.
-- ====================================================================

-- 1. Create public.provider_number_operations table
CREATE TABLE IF NOT EXISTS public.provider_number_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    operation_type TEXT NOT NULL DEFAULT 'purchase_number' CHECK (operation_type IN ('purchase_number')),
    provider TEXT NOT NULL DEFAULT 'twilio',
    phone_number_e164 TEXT NOT NULL CHECK (phone_number_e164 ~ '^\+[1-9]\d{1,14}$'),
    number_type TEXT NOT NULL CHECK (number_type IN ('local', 'mobile', 'toll_free')),
    country_code TEXT NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN (
            'pending',
            'in_progress',
            'succeeded',
            'failed',
            'reconciliation_required',
            'manual_review_required'
        )
    ),
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
    provider_resource_id TEXT NULL,
    provider_status TEXT NULL,
    
    -- Commercial Price Snapshot
    retail_amount_minor INT NOT NULL CHECK (retail_amount_minor >= 0),
    retail_currency TEXT NOT NULL CHECK (retail_currency ~ '^[A-Z]{3}$'),
    provider_cost_minor INT NOT NULL CHECK (provider_cost_minor >= 0),
    provider_cost_currency TEXT NOT NULL CHECK (provider_cost_currency ~ '^[A-Z]{3}$'),
    pricing_source TEXT NOT NULL CHECK (pricing_source IN ('explicit_override', 'pricing_policy')),
    pricing_policy_id UUID NULL REFERENCES public.phone_number_pricing_policies(id) ON DELETE SET NULL,
    target_margin_pct NUMERIC(5,2) NULL,
    minimum_fixed_margin_minor INT NULL,
    gross_margin_minor INT NOT NULL,
    price_resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    price_snapshot_payload JSONB NOT NULL,

    -- Regulatory Provisioning Context (Extensible JSONB + Foreign Keys)
    compliance_profile_id UUID NULL REFERENCES public.organization_compliance_profiles(id) ON DELETE SET NULL,
    regulatory_bundle_sid TEXT NULL,
    regulatory_provisioning_context JSONB NOT NULL,

    -- Payment Boundary Integration References
    payment_authorization_id TEXT NULL,
    payment_status TEXT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'authorized', 'captured', 'released', 'waived')),

    -- Operations & Error Tracking
    attempt_count INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    started_at TIMESTAMPTZ NULL,
    completed_at TIMESTAMPTZ NULL,
    last_reconciled_at TIMESTAMPTZ NULL,
    sanitized_error_code TEXT NULL,
    sanitized_error_message TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT unique_org_number_op_idempotency UNIQUE (organization_id, idempotency_key)
);

-- 2. Indexes for provider_number_operations
CREATE INDEX IF NOT EXISTS idx_provider_num_ops_org_id 
ON public.provider_number_operations(organization_id);

CREATE INDEX IF NOT EXISTS idx_provider_num_ops_status 
ON public.provider_number_operations(status);

-- 3. GLOBAL ACTIVE E.164 PURCHASE LOCK
-- Scoped strictly to purchase_number and active/ambiguous states (pending, in_progress, reconciliation_required, manual_review_required).
-- Terminal states (succeeded, failed) leave this index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_purchase_number_lock 
ON public.provider_number_operations(phone_number_e164) 
WHERE operation_type = 'purchase_number' 
AND status IN ('pending', 'in_progress', 'reconciliation_required', 'manual_review_required');

-- 4. PERMANENT OWNERSHIP UNIQUENESS PROTECTION ON phone_numbers
-- Establishes partial unique index for active ownership states
CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_numbers_active_ownership 
ON public.phone_numbers (phone_number) 
WHERE status IN ('active', 'inactive', 'suspended');

-- Safely drop legacy un-scoped global phone_number constraint if present
ALTER TABLE public.phone_numbers DROP CONSTRAINT IF EXISTS phone_numbers_phone_number_key;

-- 5. Updated_at Trigger for provider_number_operations
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'update_provider_num_ops_updated_at'
    ) THEN
        CREATE TRIGGER update_provider_num_ops_updated_at
            BEFORE UPDATE ON public.provider_number_operations
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- 6. Atomic Operation Creation and Claim RPC Function (Hardened SECURITY DEFINER)
CREATE OR REPLACE FUNCTION public.create_and_claim_number_purchase_op(
    p_organization_id UUID,
    p_phone_number_e164 TEXT,
    p_country_code TEXT,
    p_number_type TEXT,
    p_idempotency_key TEXT,
    p_request_fingerprint TEXT,
    p_retail_amount_minor INT,
    p_retail_currency TEXT,
    p_provider_cost_minor INT,
    p_provider_cost_currency TEXT,
    p_pricing_source TEXT,
    p_pricing_policy_id UUID,
    p_gross_margin_minor INT,
    p_price_snapshot_payload JSONB,
    p_compliance_profile_id UUID,
    p_regulatory_bundle_sid TEXT,
    p_regulatory_provisioning_context JSONB
) RETURNS public.provider_number_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_existing public.provider_number_operations;
    v_new_op public.provider_number_operations;
BEGIN
    -- 1. Check existing idempotency key for organization
    SELECT * INTO v_existing 
    FROM public.provider_number_operations 
    WHERE organization_id = p_organization_id AND idempotency_key = p_idempotency_key;

    IF FOUND THEN
        IF v_existing.request_fingerprint <> p_request_fingerprint THEN
            RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: Request fingerprint does not match existing idempotency key.' USING ERRCODE = '23505';
        END IF;
        RETURN v_existing;
    END IF;

    -- 2. Check active ownership in phone_numbers
    IF EXISTS (
        SELECT 1 FROM public.phone_numbers 
        WHERE phone_number = p_phone_number_e164 AND status IN ('active', 'inactive', 'suspended')
    ) THEN
        RAISE EXCEPTION 'NUMBER_ALREADY_OWNED: The requested phone number is already owned on the platform.' USING ERRCODE = '23505';
    END IF;

    -- 3. Insert and atomically claim 'in_progress' status
    INSERT INTO public.provider_number_operations (
        organization_id, operation_type, provider, phone_number_e164, number_type, country_code,
        status, idempotency_key, request_fingerprint, retail_amount_minor, retail_currency,
        provider_cost_minor, provider_cost_currency, pricing_source, pricing_policy_id,
        gross_margin_minor, price_snapshot_payload, compliance_profile_id, regulatory_bundle_sid,
        regulatory_provisioning_context, attempt_count, started_at
    ) VALUES (
        p_organization_id, 'purchase_number', 'twilio', p_phone_number_e164, p_number_type, p_country_code,
        'in_progress', p_idempotency_key, p_request_fingerprint, p_retail_amount_minor, p_retail_currency,
        p_provider_cost_minor, p_provider_cost_currency, p_pricing_source, p_pricing_policy_id,
        p_gross_margin_minor, p_price_snapshot_payload, p_compliance_profile_id, p_regulatory_bundle_sid,
        p_regulatory_provisioning_context, 1, NOW()
    ) RETURNING * INTO v_new_op;

    RETURN v_new_op;
END;
$$;

-- Explicitly revoke execution on create_and_claim_number_purchase_op from all client roles
REVOKE EXECUTE ON FUNCTION public.create_and_claim_number_purchase_op(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INT, TEXT, INT, TEXT, TEXT, UUID, INT, JSONB, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;

-- Grant execution strictly to service_role
GRANT EXECUTE ON FUNCTION public.create_and_claim_number_purchase_op(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INT, TEXT, INT, TEXT, TEXT, UUID, INT, JSONB, UUID, TEXT, JSONB
) TO service_role;

-- 7. Atomic Idempotent Ownership Reconciliation RPC Function (Hardened SECURITY DEFINER)
CREATE OR REPLACE FUNCTION public.reconcile_provider_number_purchase(
    p_operation_id UUID,
    p_provider_resource_id TEXT,
    p_provider_status TEXT DEFAULT 'active'
) RETURNS public.provider_number_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_op public.provider_number_operations;
    v_phone_id UUID;
BEGIN
    SELECT * INTO v_op FROM public.provider_number_operations WHERE id = p_operation_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'OPERATION_NOT_FOUND: Operation ID % does not exist.', p_operation_id;
    END IF;

    -- 1. Ensure phone_numbers record exists idempotently
    INSERT INTO public.phone_numbers (
        organization_id, phone_number, country_code, number_type, status, acquisition_source, active
    ) VALUES (
        v_op.organization_id, v_op.phone_number_e164, v_op.country_code, v_op.number_type, 'active', 'provider_purchase', true
    )
    ON CONFLICT (phone_number) DO UPDATE SET status = 'active', active = true
    RETURNING id INTO v_phone_id;

    -- 2. Ensure number_provider_mappings record exists idempotently
    INSERT INTO public.number_provider_mappings (
        phone_number_id, provider, provider_resource_id, provider_status
    ) VALUES (
        v_phone_id, v_op.provider, p_provider_resource_id, p_provider_status
    )
    ON CONFLICT (provider, provider_resource_id) DO UPDATE SET provider_status = p_provider_status;

    -- 3. Update operation to succeeded
    UPDATE public.provider_number_operations
    SET status = 'succeeded',
        provider_resource_id = p_provider_resource_id,
        provider_status = p_provider_status,
        completed_at = NOW(),
        last_reconciled_at = NOW()
    WHERE id = p_operation_id
    RETURNING * INTO v_op;

    RETURN v_op;
END;
$$;

-- Explicitly revoke execution on reconcile_provider_number_purchase from all client roles
REVOKE EXECUTE ON FUNCTION public.reconcile_provider_number_purchase(
    UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;

-- Grant execution strictly to service_role
GRANT EXECUTE ON FUNCTION public.reconcile_provider_number_purchase(
    UUID, TEXT, TEXT
) TO service_role;

-- 8. Server-Managed Table Security (Strict RLS & Privileges)
ALTER TABLE public.provider_number_operations ENABLE ROW LEVEL SECURITY;

-- Revoke ALL table access from client browser roles (anon, authenticated)
REVOKE ALL ON TABLE public.provider_number_operations FROM PUBLIC, anon, authenticated;

-- Grant full administrative table privileges ONLY to service_role
GRANT ALL ON TABLE public.provider_number_operations TO service_role;
