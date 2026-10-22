-- Phase 13.4.3C Subphase C.5C.3D Forward Remediation Migration R5
-- Fix billing_payment_operations status check constraint violation in record_auto_topup_provider_payment_id_atomic

CREATE OR REPLACE FUNCTION public.record_auto_topup_provider_payment_id_atomic(
  p_organization_id UUID,
  p_trigger_id UUID,
  p_provider_payment_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_trigger public.billing_auto_topup_triggers;
BEGIN
  IF p_organization_id IS NULL OR p_trigger_id IS NULL OR p_provider_payment_id IS NULL OR TRIM(p_provider_payment_id) = '' THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS: p_organization_id, p_trigger_id, and p_provider_payment_id are required.';
  END IF;

  SELECT * INTO v_trigger
  FROM public.billing_auto_topup_triggers
  WHERE id = p_trigger_id AND organization_id = p_organization_id
  FOR UPDATE;

  IF v_trigger.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'TRIGGER_NOT_FOUND');
  END IF;

  IF v_trigger.provider_payment_id IS NOT NULL THEN
    IF v_trigger.provider_payment_id = TRIM(p_provider_payment_id) THEN
      RETURN jsonb_build_object('success', true, 'already_recorded', true, 'provider_payment_id', v_trigger.provider_payment_id);
    ELSE
      RETURN jsonb_build_object('success', false, 'reason', 'PROVIDER_PAYMENT_ID_MISMATCH', 'existing_id', v_trigger.provider_payment_id, 'attempted_id', p_provider_payment_id);
    END IF;
  END IF;

  UPDATE public.billing_auto_topup_triggers
  SET provider_payment_id = TRIM(p_provider_payment_id),
      status = CASE WHEN status = 'claimed' THEN 'processing' ELSE status END,
      updated_at = NOW()
  WHERE id = p_trigger_id;

  IF v_trigger.payment_operation_id IS NOT NULL THEN
    UPDATE public.billing_payment_operations
    SET provider_payment_id = TRIM(p_provider_payment_id),
        updated_at = NOW()
    WHERE id = v_trigger.payment_operation_id AND (provider_payment_id IS NULL OR provider_payment_id = TRIM(p_provider_payment_id));
  END IF;

  RETURN jsonb_build_object('success', true, 'already_recorded', false, 'provider_payment_id', TRIM(p_provider_payment_id));
END;
$$;

REVOKE ALL ON FUNCTION public.record_auto_topup_provider_payment_id_atomic(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_auto_topup_provider_payment_id_atomic(UUID, UUID, TEXT) TO service_role;
