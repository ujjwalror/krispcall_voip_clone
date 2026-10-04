-- Phase 14.1C: Forward Hardening for Atomic Port-Out Completion RPC
-- Corrects deployed complete_port_out_atomic to enforce strict source status validation
-- and fail-closed phone_numbers relationship verification.
-- STRICT SECURITY:
-- - SECURITY DEFINER with explicit search_path
-- - Scoped strictly to authenticated organization_id
-- - REVOKED from PUBLIC, anon, and authenticated roles; GRANTED ONLY to service_role.

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
DECLARE
  v_op RECORD;
  v_e164 TEXT;
  v_phone_id UUID;
  v_phone_rows INTEGER := 0;
BEGIN
  -- 1. Lock and verify Port-Out operation for organization
  SELECT * INTO v_op
  FROM public.number_port_operations
  WHERE id = p_operation_id
    AND organization_id = p_organization_id
    AND direction = 'port_out'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'OPERATION_NOT_FOUND: Port-Out operation % not found for organization %.', p_operation_id, p_organization_id;
  END IF;

  -- 2. Idempotent check: If already ported_out, return idempotent success
  IF v_op.status = 'ported_out' THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotent', true,
      'operation_id', v_op.id,
      'status', 'ported_out',
      'message', 'Operation already in terminal ported_out state.'
    );
  END IF;

  -- 3. Strict Source Status Validation: Only port_out_pending or carrier_processing can transition to ported_out
  IF v_op.status NOT IN ('port_out_pending', 'carrier_processing') THEN
    RAISE EXCEPTION 'INVALID_SOURCE_STATUS: Cannot complete Port-Out operation % from current status ''%''. Completion requires port_out_pending or carrier_processing.', p_operation_id, v_op.status;
  END IF;

  v_e164 := v_op.phone_number_e164;
  v_phone_id := v_op.phone_number_id;

  -- 4. Update number_port_operations status -> ported_out
  UPDATE public.number_port_operations
  SET status = 'ported_out',
      completed_at = p_completed_at,
      customer_message = p_customer_message,
      updated_at = NOW()
  WHERE id = v_op.id;

  -- 5. Update phone_numbers status -> ported_out, is_active = false
  -- MUST fail closed if zero rows updated (relationship missing or mismatched)
  IF v_phone_id IS NOT NULL THEN
    UPDATE public.phone_numbers
    SET status = 'ported_out',
        is_active = false,
        updated_at = NOW()
    WHERE id = v_phone_id
      AND organization_id = p_organization_id;
    GET DIAGNOSTICS v_phone_rows = ROW_COUNT;
  ELSE
    UPDATE public.phone_numbers
    SET status = 'ported_out',
        is_active = false,
        updated_at = NOW()
    WHERE phone_number_e164 = v_e164
      AND organization_id = p_organization_id;
    GET DIAGNOSTICS v_phone_rows = ROW_COUNT;
  END IF;

  IF v_phone_rows = 0 THEN
    RAISE EXCEPTION 'PHONE_NUMBER_NOT_FOUND: Active phone number for Port-Out operation % not found or organization mismatch.', p_operation_id;
  END IF;

  -- 6. End organization_billable_resources resource -> status = inactive
  UPDATE public.organization_billable_resources
  SET status = 'inactive',
      ended_at = p_completed_at,
      updated_at = NOW()
  WHERE organization_id = p_organization_id
    AND resource_type = 'phone_number'
    AND resource_identifier = v_e164
    AND status = 'active';

  RETURN jsonb_build_object(
    'success', true,
    'idempotent', false,
    'operation_id', v_op.id,
    'phone_number_e164', v_e164,
    'status', 'ported_out'
  );
END;
$$;

-- Security Grants: Only service_role can execute atomic completion RPC
REVOKE ALL ON FUNCTION public.complete_port_out_atomic(UUID, UUID, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_port_out_atomic(UUID, UUID, TIMESTAMPTZ, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.complete_port_out_atomic(UUID, UUID, TIMESTAMPTZ, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_port_out_atomic(UUID, UUID, TIMESTAMPTZ, TEXT) TO service_role;
