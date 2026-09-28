-- ====================================================================
-- PUBLIC SAAS PHASE 13.3.1 — COMMERCIAL SAGA SCHEMA & STATE MACHINE (HARDENED PRE-DEPLOYMENT)
-- Date: 2026-12-02
-- Establishes public.commercial_number_purchase_sagas coordinating table,
-- comprehensive unresolved saga active locks, immutable commercial authorization triggers,
-- purpose-built provisioning claim RPC, RLS security, and strict service_role privilege controls.
-- DO NOT EXECUTE REMOTELY AUTOMATICALLY — Subject to manual DBA review.
-- LOCAL DEFINITION ONLY.
-- ====================================================================

-- 1. Create public.commercial_number_purchase_sagas table
CREATE TABLE IF NOT EXISTS public.commercial_number_purchase_sagas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    payment_operation_id UUID NOT NULL UNIQUE REFERENCES public.billing_payment_operations(id) ON DELETE RESTRICT,
    provider_number_operation_id UUID NULL UNIQUE REFERENCES public.provider_number_operations(id) ON DELETE RESTRICT,
    phone_number_e164 TEXT NOT NULL CHECK (phone_number_e164 ~ '^\+[1-9]\d{1,14}$'),
    state TEXT NOT NULL DEFAULT 'awaiting_authorization' CHECK (
        state IN (
            'awaiting_authorization',
            'authorized',
            'provisioning_claimed',
            'provisioning_in_progress',
            'provider_reconciliation_required',
            'ownership_confirmed',
            'capture_pending',
            'completed',
            'authorization_cancel_pending',
            'authorization_canceled',
            'financial_reconciliation_required',
            'manual_review_required',
            'failed'
        )
    ),
    retail_amount_minor BIGINT NOT NULL CHECK (retail_amount_minor >= 0),
    currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    price_snapshot_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    attempt_count INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    failure_code TEXT NULL,
    failure_message TEXT NULL,
    reconciliation_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    completed_at TIMESTAMPTZ NULL
);

-- Index for organization queries
CREATE INDEX IF NOT EXISTS idx_commercial_sagas_org 
ON public.commercial_number_purchase_sagas(organization_id);

-- Index for saga state monitoring
CREATE INDEX IF NOT EXISTS idx_commercial_sagas_state 
ON public.commercial_number_purchase_sagas(state);

-- Index for foreign key lookups
CREATE INDEX IF NOT EXISTS idx_commercial_sagas_provider_op 
ON public.commercial_number_purchase_sagas(provider_number_operation_id)
WHERE provider_number_operation_id IS NOT NULL;

-- HARDENED DEFECT 2 FIX: Partial unique index guaranteeing at most ONE active/unresolved saga per (organization_id, phone_number_e164).
-- Includes ALL 10 unresolved/non-terminal states.
-- ONLY genuinely resolved terminal states (completed, authorization_canceled, failed) release this saga-level lock.
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_commercial_saga_lock
ON public.commercial_number_purchase_sagas(organization_id, phone_number_e164)
WHERE state IN (
    'awaiting_authorization',
    'authorized',
    'provisioning_claimed',
    'provisioning_in_progress',
    'provider_reconciliation_required',
    'ownership_confirmed',
    'capture_pending',
    'authorization_cancel_pending',
    'financial_reconciliation_required',
    'manual_review_required'
);

-- Trigger for updated_at
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_commercial_sagas_updated_at'
    ) THEN
        CREATE TRIGGER trg_commercial_sagas_updated_at
            BEFORE UPDATE ON public.commercial_number_purchase_sagas
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;


-- 2. HARDENED DEFECT 4 FIX: Immutable Commercial Authorization Snapshot Trigger
CREATE OR REPLACE FUNCTION public.prevent_commercial_saga_snapshot_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- Prohibit mutation of core commercial identity & snapshot fields
    IF OLD.organization_id IS DISTINCT FROM NEW.organization_id OR
       OLD.payment_operation_id IS DISTINCT FROM NEW.payment_operation_id OR
       OLD.phone_number_e164 IS DISTINCT FROM NEW.phone_number_e164 OR
       OLD.retail_amount_minor IS DISTINCT FROM NEW.retail_amount_minor OR
       OLD.currency IS DISTINCT FROM NEW.currency OR
       OLD.price_snapshot_payload IS DISTINCT FROM NEW.price_snapshot_payload THEN
        RAISE EXCEPTION 'IMMUTABLE_COMMERCIAL_SNAPSHOT: Core commercial authorization fields (organization_id, payment_operation_id, phone_number_e164, retail_amount_minor, currency, price_snapshot_payload) cannot be modified after saga creation.' USING ERRCODE = '42883';
    END IF;

    -- Prohibit altering provider_number_operation_id once it has been attached
    IF OLD.provider_number_operation_id IS NOT NULL AND NEW.provider_number_operation_id IS DISTINCT FROM OLD.provider_number_operation_id THEN
        RAISE EXCEPTION 'IMMUTABLE_PROVIDER_OP_LINK: provider_number_operation_id cannot be altered or unlinked once attached to a commercial saga.' USING ERRCODE = '42883';
    END IF;

    RETURN NEW;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_no_mutation_commercial_saga_snapshot'
    ) THEN
        CREATE TRIGGER trg_no_mutation_commercial_saga_snapshot
            BEFORE UPDATE ON public.commercial_number_purchase_sagas
            FOR EACH ROW EXECUTE FUNCTION public.prevent_commercial_saga_snapshot_mutation();
    END IF;
END $$;


-- 3. HARDENED DEFECT 1 FIX: Purpose-Built Provisioning Claim RPC
-- Replaces generic arbitrary state transition RPC with a single-purpose, non-arbitrary claim function.
CREATE OR REPLACE FUNCTION public.claim_commercial_saga_for_provisioning(
    p_saga_id UUID,
    p_organization_id UUID
) RETURNS public.commercial_number_purchase_sagas
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_saga public.commercial_number_purchase_sagas;
BEGIN
    -- Input validation
    IF p_saga_id IS NULL OR p_organization_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_saga_id and p_organization_id are required.' USING ERRCODE = '22023';
    END IF;

    -- Lock row for update
    SELECT * INTO v_saga
    FROM public.commercial_number_purchase_sagas
    WHERE id = p_saga_id
    FOR UPDATE;

    IF v_saga IS NULL THEN
        RAISE EXCEPTION 'SAGA_NOT_FOUND: Commercial saga % does not exist.', p_saga_id USING ERRCODE = 'P0002';
    END IF;

    -- Server-authoritative organization tenant check
    IF v_saga.organization_id <> p_organization_id THEN
        RAISE EXCEPTION 'TENANT_MISMATCH: Commercial saga % does not belong to organization %.',
            p_saga_id, p_organization_id USING ERRCODE = '42501';
    END IF;

    -- Strict state check: MUST be in state 'authorized'
    IF v_saga.state <> 'authorized' THEN
        RAISE EXCEPTION 'INVALID_SAGA_STATE_TRANSITION: Saga % is in state %, expected authorized.',
            p_saga_id, v_saga.state USING ERRCODE = '55000';
    END IF;

    -- Atomically transition ONLY to 'provisioning_claimed'
    UPDATE public.commercial_number_purchase_sagas
    SET state = 'provisioning_claimed',
        attempt_count = v_saga.attempt_count + 1,
        updated_at = pg_catalog.now()
    WHERE id = p_saga_id
    RETURNING * INTO v_saga;

    RETURN v_saga;
END;
$$;

-- Security hardening: Fixed search_path, revokes from PUBLIC/anon/authenticated, grant strictly to service_role
REVOKE EXECUTE ON FUNCTION public.claim_commercial_saga_for_provisioning(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_commercial_saga_for_provisioning(UUID, UUID) TO service_role;


-- 4. ENABLE ROW LEVEL SECURITY AND PRIVILEGES
ALTER TABLE public.commercial_number_purchase_sagas ENABLE ROW LEVEL SECURITY;

-- Revoke mutation privileges from client roles
REVOKE ALL ON public.commercial_number_purchase_sagas FROM PUBLIC, anon, authenticated;

-- Grant full access strictly to service_role
GRANT ALL ON public.commercial_number_purchase_sagas TO service_role;

-- Allow authenticated users to SELECT sagas belonging strictly to their active organization
CREATE POLICY "authenticated_select_commercial_sagas"
ON public.commercial_number_purchase_sagas FOR SELECT TO authenticated
USING (
    organization_id IN (
        SELECT prof.organization_id FROM public.profiles prof
        WHERE prof.id = auth.uid() AND prof.active = TRUE
    )
);

GRANT SELECT ON public.commercial_number_purchase_sagas TO authenticated;
