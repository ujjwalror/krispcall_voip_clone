-- ====================================================================
-- MIGRATION: PHASE 14.1D VOLUNTARY PHONE NUMBER RELEASE FOUNDATION
-- Date: 2027-01-12
-- Establishes durable public.number_release_operations table,
-- active-release partial uniqueness index, server-only RLS boundaries,
-- and hardened atomic release completion RPC (public.complete_number_release_atomic).
-- LOCAL MIGRATION ONLY — DO NOT EXECUTE REMOTELY AUTOMATICALLY.
-- ====================================================================

-- 1. Create public.number_release_operations table
CREATE TABLE IF NOT EXISTS public.number_release_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    phone_number_id UUID NOT NULL REFERENCES public.phone_numbers(id) ON DELETE RESTRICT,
    phone_number_e164 TEXT NOT NULL,
    release_source TEXT NOT NULL CHECK (release_source IN ('voluntary', 'automatic')),
    status TEXT NOT NULL DEFAULT 'requested' CHECK (
        status IN (
            'requested',
            'eligibility_verified',
            'provider_release_pending',
            'reconciliation_required',
            'released',
            'failed',
            'canceled',
            'manual_review_required'
        )
    ),
    idempotency_key TEXT NULL,
    request_fingerprint TEXT NULL,
    initiated_by_user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    provider TEXT NOT NULL DEFAULT 'twilio',
    provider_resource_mapping_id UUID NULL REFERENCES public.number_provider_mappings(id) ON DELETE SET NULL,
    provider_operation_reference TEXT NULL,
    provider_attempt_count INT NOT NULL DEFAULT 0,
    last_provider_attempt_at TIMESTAMPTZ NULL,
    ambiguity_started_at TIMESTAMPTZ NULL,
    last_reconciliation_at TIMESTAMPTZ NULL,
    reconciliation_attempt_count INT NOT NULL DEFAULT 0,
    failure_class TEXT NULL,
    customer_safe_status TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ NULL,
    CONSTRAINT unique_org_release_op_idempotency UNIQUE (organization_id, idempotency_key)
);

-- Indexes for performance & query isolation
CREATE INDEX IF NOT EXISTS idx_number_release_ops_org_id ON public.number_release_operations(organization_id);
CREATE INDEX IF NOT EXISTS idx_number_release_ops_phone_id ON public.number_release_operations(phone_number_id);
CREATE INDEX IF NOT EXISTS idx_number_release_ops_status ON public.number_release_operations(status);

-- CONCURRENCY INVARIANT: Active Release Operation Partial Unique Index
-- Prevents duplicate or racing active release operations on the same phone number
CREATE UNIQUE INDEX IF NOT EXISTS idx_number_release_ops_active_phone
ON public.number_release_operations (phone_number_id)
WHERE status NOT IN ('released', 'failed', 'canceled');

-- Updated_at trigger
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'update_number_release_operations_updated_at'
    ) THEN
        CREATE TRIGGER update_number_release_operations_updated_at
            BEFORE UPDATE ON public.number_release_operations
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- 2. Row Level Security (RLS) & Server-Only Privilege Boundaries
ALTER TABLE public.number_release_operations ENABLE ROW LEVEL SECURITY;

-- Revoke ALL table privileges from PUBLIC, anon, and authenticated roles.
-- public.number_release_operations is a SERVER-ONLY infrastructure table.
REVOKE ALL ON public.number_release_operations FROM PUBLIC, anon, authenticated;

-- Grant FULL permissions strictly to service_role
GRANT ALL ON public.number_release_operations TO service_role;

-- 3. Create Atomic Completion RPC
CREATE OR REPLACE FUNCTION public.complete_number_release_atomic(
    p_operation_id UUID,
    p_organization_id UUID,
    p_released_at TIMESTAMPTZ DEFAULT NULL,
    p_release_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_op RECORD;
    v_phone RECORD;
    v_released_ts TIMESTAMPTZ;
BEGIN
    v_released_ts := COALESCE(p_released_at, NOW());

    -- 1. Lock and fetch release operation
    SELECT * INTO v_op
    FROM public.number_release_operations
    WHERE id = p_operation_id
      AND organization_id = p_organization_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'RELEASE_OP_NOT_FOUND: Operation % for organization % not found.', p_operation_id, p_organization_id;
    END IF;

    -- 2. Idempotent Replay Handling
    IF v_op.status = 'released' THEN
        RETURN jsonb_build_object(
            'success', true,
            'idempotent', true,
            'operation_id', p_operation_id,
            'phone_number_id', v_op.phone_number_id,
            'phone_number_e164', v_op.phone_number_e164,
            'status', 'released'
        );
    END IF;

    -- 3. Verify allowed source state (MUST NOT complete from eligibility_verified or requested directly)
    IF v_op.status NOT IN ('provider_release_pending', 'reconciliation_required') THEN
        RAISE EXCEPTION 'INVALID_RELEASE_OP_STATE_FOR_COMPLETION: Operation % is in state %, completion requires provider_release_pending or reconciliation_required.', p_operation_id, v_op.status;
    END IF;

    -- 4. Lock and fetch phone number
    SELECT * INTO v_phone
    FROM public.phone_numbers
    WHERE id = v_op.phone_number_id
      AND organization_id = p_organization_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PHONE_NUMBER_NOT_FOUND: Phone number % for operation % not found or organization mismatch.', v_op.phone_number_id, p_operation_id;
    END IF;

    IF v_phone.status = 'ported_out' THEN
        RAISE EXCEPTION 'PHONE_NUMBER_ALREADY_PORTED_OUT: Phone number % is ported out.', v_phone.phone_number;
    END IF;

    -- E.164 consistency validation
    IF v_op.phone_number_e164 <> v_phone.phone_number THEN
        RAISE EXCEPTION 'E164_MISMATCH: Op E164 % does not match phone table E164 %.', v_op.phone_number_e164, v_phone.phone_number;
    END IF;

    -- 5. Execute Atomic Local Completion Mutations
    -- A. Update release operation
    UPDATE public.number_release_operations
    SET status = 'released',
        customer_safe_status = 'Number successfully released',
        completed_at = v_released_ts,
        updated_at = NOW()
    WHERE id = p_operation_id;

    -- B. Update phone number status -> released, active/is_active = false
    UPDATE public.phone_numbers
    SET status = 'released',
        active = false,
        updated_at = NOW()
    WHERE id = v_phone.id;

    -- Update is_active if column exists dynamically
    BEGIN
        UPDATE public.phone_numbers
        SET is_active = false
        WHERE id = v_phone.id;
    EXCEPTION WHEN OTHERS THEN
        -- Column is_active may not exist in some local test environments; active=false is canonical.
        NULL;
    END;

    -- C. Terminate organization billable resource -> status = terminated
    UPDATE public.organization_billable_resources
    SET status = 'terminated',
        effective_end_at = v_released_ts,
        updated_at = NOW()
    WHERE organization_id = p_organization_id
      AND resource_type = 'phone_number'
      AND (resource_id = v_phone.id::text OR resource_id = v_phone.phone_number)
      AND status = 'active';

    -- D. Mark provider mapping historical -> provider_status = historical
    UPDATE public.number_provider_mappings
    SET provider_status = 'historical',
        updated_at = NOW()
    WHERE phone_number_id = v_phone.id
      AND provider_status = 'active';

    RETURN jsonb_build_object(
        'success', true,
        'idempotent', false,
        'operation_id', p_operation_id,
        'phone_number_id', v_phone.id,
        'phone_number_e164', v_phone.phone_number,
        'status', 'released'
    );
END;
$$;

-- Security Grants: Only service_role can execute atomic completion RPC
REVOKE ALL ON FUNCTION public.complete_number_release_atomic(UUID, UUID, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_number_release_atomic(UUID, UUID, TIMESTAMPTZ, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.complete_number_release_atomic(UUID, UUID, TIMESTAMPTZ, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_number_release_atomic(UUID, UUID, TIMESTAMPTZ, TEXT) TO service_role;
