-- ====================================================================
-- MIGRATION: PHASE 23D.8B CANONICAL PROVIDER-NEUTRAL NUMBER PORTING ENGINE
-- Date: 2027-04-28
-- Extends public.number_port_operations with subaccount scoping,
-- canonical state authority, reconciliation state, FOC milestones,
-- requirement snapshot references, immutable security events,
-- multi-worker claiming columns, and atomic canonical completion RPCs.
-- LOCAL MIGRATION ONLY — DO NOT EXECUTE REMOTELY AUTOMATICALLY.
-- ====================================================================

-- 1. Create public.number_port_requirement_snapshots table
CREATE TABLE IF NOT EXISTS public.number_port_requirement_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    country_code TEXT NOT NULL,
    number_type TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('PORT_IN', 'PORT_OUT')),
    subject_type TEXT NOT NULL,
    losing_carrier TEXT NULL,
    target_provider_account_id UUID NULL REFERENCES public.telecom_provider_accounts(id) ON DELETE SET NULL,
    requires_account_number BOOLEAN NOT NULL DEFAULT false,
    requires_pin BOOLEAN NOT NULL DEFAULT false,
    requires_billing_address BOOLEAN NOT NULL DEFAULT false,
    requires_utility_invoice BOOLEAN NOT NULL DEFAULT false,
    requires_digital_eloa BOOLEAN NOT NULL DEFAULT false,
    requires_manual_document_upload BOOLEAN NOT NULL DEFAULT false,
    required_documents JSONB NOT NULL DEFAULT '[]'::jsonb,
    document_constraints JSONB NOT NULL DEFAULT '{}'::jsonb,
    provider_capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
    fingerprint TEXT NOT NULL,
    retrieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_port_req_snapshot_fingerprint UNIQUE (organization_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_port_req_snapshots_org ON public.number_port_requirement_snapshots(organization_id);
CREATE INDEX IF NOT EXISTS idx_port_req_snapshots_provider_country ON public.number_port_requirement_snapshots(provider, country_code);

-- 1b. Immutability trigger for number_port_requirement_snapshots
CREATE OR REPLACE FUNCTION public.prevent_port_requirement_snapshot_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'PORT_REQUIREMENT_SNAPSHOT_IMMUTABLE: Requirement snapshots are append-only historical records and cannot be modified or deleted.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_port_requirement_snapshots_immutable ON public.number_port_requirement_snapshots;
CREATE TRIGGER trg_port_requirement_snapshots_immutable
BEFORE UPDATE OR DELETE ON public.number_port_requirement_snapshots
FOR EACH ROW
EXECUTE FUNCTION public.prevent_port_requirement_snapshot_mutation();

-- 2. Create public.number_port_security_events table (Audit & Notification Trail)
CREATE TABLE IF NOT EXISTS public.number_port_security_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    operation_id UUID NULL REFERENCES public.number_port_operations(id) ON DELETE SET NULL,
    phone_number_e164 TEXT NOT NULL,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
    actor_identity TEXT NOT NULL,
    event_details JSONB NOT NULL DEFAULT '{}'::jsonb,
    notification_dispatched BOOLEAN NOT NULL DEFAULT false,
    dispatched_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_port_sec_events_org ON public.number_port_security_events(organization_id);
CREATE INDEX IF NOT EXISTS idx_port_sec_events_e164 ON public.number_port_security_events(phone_number_e164);
CREATE INDEX IF NOT EXISTS idx_port_sec_events_type ON public.number_port_security_events(event_type);

-- 3. Additive Columns to public.number_port_operations
ALTER TABLE public.number_port_operations
    ADD COLUMN IF NOT EXISTS provider_account_id UUID NULL REFERENCES public.telecom_provider_accounts(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS canonical_state TEXT NOT NULL DEFAULT 'DRAFT',
    ADD COLUMN IF NOT EXISTS reconciliation_state TEXT NULL,
    ADD COLUMN IF NOT EXISTS outcome_certainty TEXT NULL,
    ADD COLUMN IF NOT EXISTS requirement_snapshot_id UUID NULL REFERENCES public.number_port_requirement_snapshots(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS regulatory_subject_id UUID NULL REFERENCES public.regulatory_subjects(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS requested_foc_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS estimated_foc_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS confirmed_foc_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS actual_completed_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS provider_dispatched_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS provider_acknowledged_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS customer_action_required_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS manual_review_required_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS port_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS remediation_history JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS port_security_policy JSONB NOT NULL DEFAULT '{"portOutLocked": true, "stepUpAuthRequired": true, "cooldownSeconds": 0}'::jsonb,
    ADD COLUMN IF NOT EXISTS authorized_name TEXT NULL,
    ADD COLUMN IF NOT EXISTS authorized_email TEXT NULL,
    ADD COLUMN IF NOT EXISTS service_address JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS locked_by_worker_id TEXT NULL,
    ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ NULL;

-- Indexes for distributed operations and multi-worker safety
CREATE INDEX IF NOT EXISTS idx_number_port_ops_canonical_state ON public.number_port_operations(canonical_state);
CREATE INDEX IF NOT EXISTS idx_number_port_ops_provider_account ON public.number_port_operations(provider_account_id);
CREATE INDEX IF NOT EXISTS idx_number_port_ops_worker_claim ON public.number_port_operations(canonical_state, locked_until) WHERE locked_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_number_port_ops_foc_schedule ON public.number_port_operations(confirmed_foc_at) WHERE confirmed_foc_at IS NOT NULL;

-- 4. Canonical Atomic Port-Out Completion RPC
CREATE OR REPLACE FUNCTION public.complete_port_out_canonical_atomic(
  p_operation_id UUID,
  p_organization_id UUID,
  p_completed_at TIMESTAMPTZ DEFAULT NOW(),
  p_customer_message TEXT DEFAULT 'Number transfer completed successfully to receiving carrier.',
  p_actor_identity TEXT DEFAULT 'provider_reconciliation'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_op RECORD;
  v_e164 TEXT;
  v_phone_id UUID;
  v_phone_rows INTEGER := 0;
BEGIN
  -- 1. Lock and verify Port-Out operation
  SELECT * INTO v_op
  FROM public.number_port_operations
  WHERE id = p_operation_id
    AND organization_id = p_organization_id
    AND direction IN ('port_out', 'PORT_OUT')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'OPERATION_NOT_FOUND: Port-Out operation % not found for organization %.', p_operation_id, p_organization_id;
  END IF;

  -- 2. Idempotency Check: Already completed
  IF v_op.canonical_state = 'COMPLETED' OR v_op.status = 'ported_out' THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotent', true,
      'operation_id', v_op.id,
      'canonical_state', 'COMPLETED',
      'status', 'ported_out',
      'message', 'Operation already in terminal completed/ported_out state.'
    );
  END IF;

  v_e164 := v_op.phone_number_e164;
  v_phone_id := v_op.phone_number_id;

  -- Protected Pilot Quarantine
  IF v_e164 = '+61348328472' OR v_phone_id = '03edd0bc-b025-49e6-8171-a0c2fcd6cb78'::uuid THEN
    RAISE EXCEPTION 'PROTECTED_PILOT_QUARANTINE: Australian pilot number cannot be ported out.';
  END IF;

  -- 3. Update number_port_operations
  UPDATE public.number_port_operations
  SET canonical_state = 'COMPLETED',
      status = 'ported_out',
      completed_at = p_completed_at,
      actual_completed_at = p_completed_at,
      customer_message = p_customer_message,
      updated_at = NOW()
  WHERE id = v_op.id;

  -- 4. Update phone_numbers: ownership_state = PORTED_OUT, service_state = UNAVAILABLE
  IF v_phone_id IS NOT NULL THEN
    UPDATE public.phone_numbers
    SET ownership_state = 'PORTED_OUT',
        service_state = 'UNAVAILABLE',
        porting_state = 'NONE',
        status = 'ported_out',
        is_active = false,
        updated_at = NOW()
    WHERE id = v_phone_id
      AND organization_id = p_organization_id;
    GET DIAGNOSTICS v_phone_rows = ROW_COUNT;
  ELSE
    UPDATE public.phone_numbers
    SET ownership_state = 'PORTED_OUT',
        service_state = 'UNAVAILABLE',
        porting_state = 'NONE',
        status = 'ported_out',
        is_active = false,
        updated_at = NOW()
    WHERE phone_number_e164 = v_e164
      AND organization_id = p_organization_id;
    GET DIAGNOSTICS v_phone_rows = ROW_COUNT;
  END IF;

  IF v_phone_rows = 0 THEN
    RAISE EXCEPTION 'PHONE_NUMBER_NOT_FOUND: Active phone number for Port-Out operation % not found or organization mismatch.', p_operation_id;
  END IF;

  -- 5. Tombstone telecom_provider_resource_records
  UPDATE public.telecom_provider_resource_records
  SET status = 'RELEASED',
      released_at = p_completed_at,
      metadata = metadata || jsonb_build_object('tombstone_reason', 'PORTED_OUT', 'port_operation_id', v_op.id),
      updated_at = NOW()
  WHERE organization_id = p_organization_id
    AND phone_number_e164 = v_e164
    AND status = 'ACTIVE';

  -- 6. End billable resource
  UPDATE public.organization_billable_resources
  SET status = 'inactive',
      ended_at = p_completed_at,
      updated_at = NOW()
  WHERE organization_id = p_organization_id
    AND resource_type = 'phone_number'
    AND resource_identifier = v_e164
    AND status = 'active';

  -- 7. Record durable security audit event
  INSERT INTO public.number_port_security_events (
    organization_id,
    operation_id,
    phone_number_e164,
    event_type,
    severity,
    actor_identity,
    event_details
  ) VALUES (
    p_organization_id,
    v_op.id,
    v_e164,
    'PORT_OUT_COMPLETED',
    'INFO',
    p_actor_identity,
    jsonb_build_object(
      'completed_at', p_completed_at,
      'phone_number_id', v_phone_id,
      'customer_message', p_customer_message
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'idempotent', false,
    'operation_id', v_op.id,
    'phone_number_e164', v_e164,
    'canonical_state', 'COMPLETED',
    'ownership_state', 'PORTED_OUT'
  );
END;
$$;

-- 5. Canonical Atomic Port-In Completion RPC
CREATE OR REPLACE FUNCTION public.complete_port_in_canonical_atomic(
  p_operation_id UUID,
  p_organization_id UUID,
  p_provider_account_id UUID,
  p_remote_resource_id TEXT,
  p_completed_at TIMESTAMPTZ DEFAULT NOW(),
  p_customer_message TEXT DEFAULT 'Number port-in cutover verified successfully.',
  p_actor_identity TEXT DEFAULT 'provider_reconciliation'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_op RECORD;
  v_e164 TEXT;
  v_phone_id UUID;
  v_resource_record_id UUID;
  v_phone_rows INTEGER := 0;
BEGIN
  -- 1. Lock and verify Port-In operation
  SELECT * INTO v_op
  FROM public.number_port_operations
  WHERE id = p_operation_id
    AND organization_id = p_organization_id
    AND direction IN ('port_in', 'PORT_IN')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'OPERATION_NOT_FOUND: Port-In operation % not found for organization %.', p_operation_id, p_organization_id;
  END IF;

  -- 2. Verify target provider subaccount
  IF v_op.provider_account_id IS NOT NULL AND v_op.provider_account_id != p_provider_account_id THEN
    RAISE EXCEPTION 'PROVIDER_ACCOUNT_MISMATCH: Target provider account % does not match operation %.', p_provider_account_id, v_op.provider_account_id;
  END IF;

  -- 3. Idempotency Check: Already completed
  IF v_op.canonical_state = 'COMPLETED' OR v_op.status = 'completed' THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotent', true,
      'operation_id', v_op.id,
      'canonical_state', 'COMPLETED',
      'status', 'completed',
      'message', 'Operation already in terminal completed state.'
    );
  END IF;

  v_e164 := v_op.phone_number_e164;
  v_phone_id := v_op.phone_number_id;

  -- Protected Pilot Quarantine
  IF v_e164 = '+61348328472'
     OR v_phone_id = '03edd0bc-b025-49e6-8171-a0c2fcd6cb78'::uuid
     OR p_remote_resource_id = 'PN832a10dec98cbb48d02033a83afecff3' THEN
    RAISE EXCEPTION 'PROTECTED_PILOT_QUARANTINE: Australian pilot number cannot be ported in.';
  END IF;

  -- 4. Establish or reconcile telecom_provider_resource_records
  INSERT INTO public.telecom_provider_resource_records (
    organization_id,
    provider_account_id,
    phone_number_e164,
    provider_resource_id,
    provider,
    resource_type,
    status,
    acquired_at,
    metadata
  ) VALUES (
    p_organization_id,
    p_provider_account_id,
    v_e164,
    p_remote_resource_id,
    v_op.provider,
    'PHONE_NUMBER',
    'ACTIVE',
    p_completed_at,
    jsonb_build_object('source', 'PORT_IN', 'operation_id', v_op.id)
  )
  ON CONFLICT (organization_id, phone_number_e164) WHERE status = 'ACTIVE'
  DO UPDATE SET
    provider_account_id = p_provider_account_id,
    provider_resource_id = p_remote_resource_id,
    updated_at = NOW()
  RETURNING id INTO v_resource_record_id;

  -- 5. Update or insert phone_numbers: ownership_state = OWNED, service_state = ACTIVE
  IF v_phone_id IS NOT NULL THEN
    UPDATE public.phone_numbers
    SET ownership_state = 'OWNED',
        service_state = 'ACTIVE',
        porting_state = 'NONE',
        status = 'active',
        is_active = true,
        provider_account_id = p_provider_account_id,
        provider_resource_record_id = v_resource_record_id,
        updated_at = NOW()
    WHERE id = v_phone_id
      AND organization_id = p_organization_id;
    GET DIAGNOSTICS v_phone_rows = ROW_COUNT;
  ELSE
    UPDATE public.phone_numbers
    SET ownership_state = 'OWNED',
        service_state = 'ACTIVE',
        porting_state = 'NONE',
        status = 'active',
        is_active = true,
        provider_account_id = p_provider_account_id,
        provider_resource_record_id = v_resource_record_id,
        updated_at = NOW()
    WHERE phone_number_e164 = v_e164
      AND organization_id = p_organization_id
    RETURNING id INTO v_phone_id;
    GET DIAGNOSTICS v_phone_rows = ROW_COUNT;
  END IF;

  IF v_phone_rows = 0 THEN
    -- If phone number was not pre-created, insert it now as OWNED & ACTIVE
    INSERT INTO public.phone_numbers (
      organization_id,
      phone_number_e164,
      ownership_state,
      service_state,
      porting_state,
      status,
      is_active,
      provider_account_id,
      provider_resource_record_id,
      created_at,
      updated_at
    ) VALUES (
      p_organization_id,
      v_e164,
      'OWNED',
      'ACTIVE',
      'NONE',
      'active',
      true,
      p_provider_account_id,
      v_resource_record_id,
      p_completed_at,
      NOW()
    )
    RETURNING id INTO v_phone_id;
  END IF;

  -- 6. Update number_port_operations
  UPDATE public.number_port_operations
  SET canonical_state = 'COMPLETED',
      status = 'completed',
      phone_number_id = v_phone_id,
      provider_account_id = p_provider_account_id,
      completed_at = p_completed_at,
      actual_completed_at = p_completed_at,
      customer_message = p_customer_message,
      updated_at = NOW()
  WHERE id = v_op.id;

  -- 7. Record durable security audit event
  INSERT INTO public.number_port_security_events (
    organization_id,
    operation_id,
    phone_number_e164,
    event_type,
    severity,
    actor_identity,
    event_details
  ) VALUES (
    p_organization_id,
    v_op.id,
    v_e164,
    'PORT_IN_COMPLETED',
    'INFO',
    p_actor_identity,
    jsonb_build_object(
      'completed_at', p_completed_at,
      'phone_number_id', v_phone_id,
      'provider_account_id', p_provider_account_id,
      'remote_resource_id', p_remote_resource_id
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'idempotent', false,
    'operation_id', v_op.id,
    'phone_number_id', v_phone_id,
    'phone_number_e164', v_e164,
    'canonical_state', 'COMPLETED',
    'ownership_state', 'OWNED',
    'service_state', 'ACTIVE'
  );
END;
$$;

-- 6. Row Level Security and Server-Only Grants
ALTER TABLE public.number_port_requirement_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.number_port_security_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.number_port_requirement_snapshots FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.number_port_requirement_snapshots TO service_role;

REVOKE ALL ON public.number_port_security_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.number_port_security_events TO service_role;

REVOKE ALL ON FUNCTION public.complete_port_out_canonical_atomic(UUID, UUID, TIMESTAMPTZ, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_port_out_canonical_atomic(UUID, UUID, TIMESTAMPTZ, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.complete_port_in_canonical_atomic(UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_port_in_canonical_atomic(UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT) TO service_role;

-- 7. Upgrade Legacy complete_port_out_atomic RPC to Canonical Invariants
CREATE OR REPLACE FUNCTION public.complete_port_out_atomic(
  p_operation_id UUID,
  p_organization_id UUID,
  p_completed_at TIMESTAMPTZ DEFAULT NOW(),
  p_customer_message TEXT DEFAULT 'Number transfer completed successfully to receiving carrier.'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN public.complete_port_out_canonical_atomic(
    p_operation_id,
    p_organization_id,
    p_completed_at,
    p_customer_message,
    'legacy_complete_port_out_atomic'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_port_out_atomic(UUID, UUID, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_port_out_atomic(UUID, UUID, TIMESTAMPTZ, TEXT) TO service_role;

