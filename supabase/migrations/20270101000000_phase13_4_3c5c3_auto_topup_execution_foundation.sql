-- Phase 13.4.3C Subphase C.5C.3B Forward Migration
-- Autonomous Auto Top-Up Execution State Machine Primitives

-- 1. RECORD AUTHORITATIVE STRIPE PAYMENTINTENT ID (FAIL-CLOSED CAS)
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
        status = CASE WHEN status = 'pending' THEN 'processing' ELSE status END,
        updated_at = NOW()
    WHERE id = v_trigger.payment_operation_id AND (provider_payment_id IS NULL OR provider_payment_id = TRIM(p_provider_payment_id));
  END IF;

  RETURN jsonb_build_object('success', true, 'already_recorded', false, 'provider_payment_id', TRIM(p_provider_payment_id));
END;
$$;

REVOKE ALL ON FUNCTION public.record_auto_topup_provider_payment_id_atomic(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_auto_topup_provider_payment_id_atomic(UUID, UUID, TEXT) TO service_role;


-- 2. FAIL AUTO TOP-UP TRIGGER & PAUSE SETTINGS
CREATE OR REPLACE FUNCTION public.fail_auto_topup_trigger_atomic(
  p_organization_id UUID,
  p_trigger_id UUID,
  p_error_code TEXT,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_trigger public.billing_auto_topup_triggers;
BEGIN
  IF p_organization_id IS NULL OR p_trigger_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS: p_organization_id and p_trigger_id are required.';
  END IF;

  SELECT * INTO v_trigger
  FROM public.billing_auto_topup_triggers
  WHERE id = p_trigger_id AND organization_id = p_organization_id
  FOR UPDATE;

  IF v_trigger.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'TRIGGER_NOT_FOUND');
  END IF;

  -- Terminal protection: do not overwrite funded
  IF v_trigger.status = 'funded' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'CANNOT_FAIL_FUNDED_TRIGGER');
  END IF;

  UPDATE public.billing_auto_topup_triggers
  SET status = 'failed',
      error_code = COALESCE(p_error_code, 'EXECUTION_FAILED'),
      updated_at = NOW()
  WHERE id = p_trigger_id;

  IF v_trigger.payment_operation_id IS NOT NULL THEN
    UPDATE public.billing_payment_operations
    SET status = 'failed',
        error_code = COALESCE(p_error_code, 'EXECUTION_FAILED'),
        updated_at = NOW()
    WHERE id = v_trigger.payment_operation_id AND status NOT IN ('succeeded');
  END IF;

  UPDATE public.billing_auto_topup_settings
  SET status = 'paused_failure',
      failure_count = failure_count + 1,
      last_failure_at = NOW(),
      updated_at = NOW()
  WHERE organization_id = p_organization_id;

  RETURN jsonb_build_object('success', true, 'status', 'failed', 'error_code', p_error_code);
END;
$$;

REVOKE ALL ON FUNCTION public.fail_auto_topup_trigger_atomic(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_auto_topup_trigger_atomic(UUID, UUID, TEXT, TEXT) TO service_role;


-- 3. MARK REQUIRES_ACTION (SCA / 3DS) FOR AUTO TOP-UP
CREATE OR REPLACE FUNCTION public.mark_auto_topup_requires_action_atomic(
  p_organization_id UUID,
  p_trigger_id UUID,
  p_client_secret TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_trigger public.billing_auto_topup_triggers;
BEGIN
  IF p_organization_id IS NULL OR p_trigger_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS: p_organization_id and p_trigger_id are required.';
  END IF;

  SELECT * INTO v_trigger
  FROM public.billing_auto_topup_triggers
  WHERE id = p_trigger_id AND organization_id = p_organization_id
  FOR UPDATE;

  IF v_trigger.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'TRIGGER_NOT_FOUND');
  END IF;

  IF v_trigger.status = 'funded' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'CANNOT_MARK_ACTION_REQUIRED_ON_FUNDED');
  END IF;

  UPDATE public.billing_auto_topup_triggers
  SET status = 'requires_action',
      updated_at = NOW()
  WHERE id = p_trigger_id;

  IF v_trigger.payment_operation_id IS NOT NULL THEN
    UPDATE public.billing_payment_operations
    SET status = 'requires_action',
        metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{client_secret}',
          to_jsonb(COALESCE(p_client_secret, ''))
        ),
        updated_at = NOW()
    WHERE id = v_trigger.payment_operation_id AND status NOT IN ('succeeded');
  END IF;

  UPDATE public.billing_auto_topup_settings
  SET status = 'action_required',
      updated_at = NOW()
  WHERE organization_id = p_organization_id;

  RETURN jsonb_build_object('success', true, 'status', 'requires_action');
END;
$$;

REVOKE ALL ON FUNCTION public.mark_auto_topup_requires_action_atomic(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_auto_topup_requires_action_atomic(UUID, UUID, TEXT) TO service_role;


-- 4. COMPLETE AUTO TOP-UP FUNDING STATE TRANSITION & RE-ARM
CREATE OR REPLACE FUNCTION public.complete_auto_topup_funding_atomic(
  p_organization_id UUID,
  p_trigger_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_trigger public.billing_auto_topup_triggers;
  v_rearm_res JSONB;
BEGIN
  IF p_organization_id IS NULL OR p_trigger_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS: p_organization_id and p_trigger_id are required.';
  END IF;

  SELECT * INTO v_trigger
  FROM public.billing_auto_topup_triggers
  WHERE id = p_trigger_id AND organization_id = p_organization_id
  FOR UPDATE;

  IF v_trigger.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'TRIGGER_NOT_FOUND');
  END IF;

  IF v_trigger.status = 'funded' THEN
    RETURN jsonb_build_object('success', true, 'already_funded', true);
  END IF;

  UPDATE public.billing_auto_topup_triggers
  SET status = 'funded',
      funded_at = NOW(),
      updated_at = NOW()
  WHERE id = p_trigger_id;

  -- Reset failure count on success
  UPDATE public.billing_auto_topup_settings
  SET failure_count = 0,
      updated_at = NOW()
  WHERE organization_id = p_organization_id;

  -- Evaluate threshold re-arm strictly (spendable_balance > threshold_minor)
  v_rearm_res := public.rearm_auto_topup_threshold_atomic(p_organization_id);

  RETURN jsonb_build_object(
    'success', true,
    'already_funded', false,
    'trigger_id', p_trigger_id,
    'rearm_result', v_rearm_res
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_auto_topup_funding_atomic(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_auto_topup_funding_atomic(UUID, UUID) TO service_role;


-- 5. AUTHORIZE AUTO TOP-UP PROVIDER MUTATION (UPDATED SHA256 FINGERPRINT)
CREATE OR REPLACE FUNCTION public.authorize_auto_topup_provider_mutation_atomic(
  p_organization_id UUID,
  p_trigger_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_settings public.billing_auto_topup_settings;
  v_trigger public.billing_auto_topup_triggers;
  v_spendable BIGINT := 0;
  v_active_holds_count INT := 0;
  v_active_debts_count INT := 0;
  v_payment_op_id UUID := NULL;
  v_idempotency_key TEXT;
  v_request_fingerprint TEXT;
BEGIN
  IF p_organization_id IS NULL OR p_trigger_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS: p_organization_id and p_trigger_id are required.';
  END IF;

  PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

  SELECT * INTO v_settings
  FROM public.billing_auto_topup_settings
  WHERE organization_id = p_organization_id
  FOR UPDATE;

  IF v_settings.id IS NULL OR v_settings.status <> 'enabled' THEN
    UPDATE public.billing_auto_topup_triggers
    SET status = 'cancelled_race', error_code = 'SETTINGS_NOT_ENABLED', updated_at = NOW()
    WHERE id = p_trigger_id;

    RETURN jsonb_build_object('success', false, 'authorized', false, 'reason', 'SETTINGS_NOT_ENABLED');
  END IF;

  SELECT * INTO v_trigger
  FROM public.billing_auto_topup_triggers
  WHERE id = p_trigger_id AND organization_id = p_organization_id
  FOR UPDATE;

  IF v_trigger.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'authorized', false, 'reason', 'TRIGGER_NOT_FOUND');
  END IF;

  IF v_trigger.status = 'provider_mutation_authorized' AND v_trigger.payment_operation_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_authorized', true,
      'trigger_id', v_trigger.id,
      'payment_operation_id', v_trigger.payment_operation_id,
      'provider_idempotency_key', v_trigger.provider_idempotency_key
    );
  END IF;

  IF v_trigger.status NOT IN ('claimed', 'processing') THEN
    RETURN jsonb_build_object('success', false, 'authorized', false, 'reason', 'INVALID_TRIGGER_STATUS', 'status', v_trigger.status);
  END IF;

  IF v_trigger.configuration_generation_snapshot <> v_settings.configuration_generation OR
     v_trigger.payment_authorization_generation_snapshot <> v_settings.payment_authorization_generation THEN

    UPDATE public.billing_auto_topup_triggers
    SET status = 'cancelled_stale_generation',
        error_code = 'STALE_GENERATION_MISMATCH',
        updated_at = NOW()
    WHERE id = v_trigger.id;

    RETURN jsonb_build_object('success', false, 'authorized', false, 'reason', 'STALE_GENERATION_MISMATCH');
  END IF;

  v_spendable := public.get_spendable_credit_balance_minor(p_organization_id);
  IF v_spendable >= v_settings.threshold_minor THEN
    UPDATE public.billing_auto_topup_triggers
    SET status = 'cancelled_race',
        error_code = 'FUNDED_BEFORE_AUTHORIZATION',
        updated_at = NOW()
    WHERE id = v_trigger.id;

    RETURN jsonb_build_object('success', false, 'authorized', false, 'reason', 'FUNDED_BEFORE_AUTHORIZATION');
  END IF;

  SELECT COUNT(*) INTO v_active_holds_count
  FROM public.billing_financial_holds
  WHERE organization_id = p_organization_id AND status = 'active';

  SELECT COUNT(*) INTO v_active_debts_count
  FROM public.billing_account_debts
  WHERE organization_id = p_organization_id AND status = 'unpaid';

  IF v_active_holds_count > 0 OR v_active_debts_count > 0 THEN
    UPDATE public.billing_auto_topup_triggers
    SET status = 'cancelled_race',
        error_code = 'RISK_STATE_PRESENT',
        updated_at = NOW()
    WHERE id = v_trigger.id;

    RETURN jsonb_build_object('success', false, 'authorized', false, 'reason', 'RISK_STATE_PRESENT');
  END IF;

  v_idempotency_key := 'atu_pi_' || v_trigger.id::text;
  v_request_fingerprint := 'sha256:' || encode(sha256(('auto_topup:' || v_trigger.id::text)::bytea), 'hex');

  INSERT INTO public.billing_payment_operations (
    organization_id,
    auto_topup_trigger_id,
    operation_type,
    provider,
    status,
    amount_minor,
    currency,
    idempotency_key,
    request_fingerprint,
    provider_customer_id,
    provider_account_id,
    metadata,
    created_at,
    updated_at
  ) VALUES (
    p_organization_id,
    v_trigger.id,
    'credit_topup',
    'stripe',
    'pending',
    v_trigger.recharge_amount_minor_snapshot,
    v_trigger.currency_snapshot,
    v_idempotency_key,
    v_request_fingerprint,
    v_trigger.provider_customer_id_snapshot,
    v_trigger.provider_account_id_snapshot,
    jsonb_build_object('auto_topup_trigger_id', v_trigger.id::text),
    NOW(),
    NOW()
  )
  ON CONFLICT (organization_id, (metadata->>'auto_topup_trigger_id')) WHERE metadata->>'auto_topup_trigger_id' IS NOT NULL
  DO UPDATE SET updated_at = NOW()
  RETURNING id INTO v_payment_op_id;

  IF v_payment_op_id IS NULL THEN
    SELECT id INTO v_payment_op_id
    FROM public.billing_payment_operations
    WHERE organization_id = p_organization_id AND (metadata->>'auto_topup_trigger_id') = v_trigger.id::text;
  END IF;

  UPDATE public.billing_auto_topup_triggers
  SET status = 'provider_mutation_authorized',
      payment_operation_id = v_payment_op_id,
      provider_idempotency_key = v_idempotency_key,
      updated_at = NOW()
  WHERE id = v_trigger.id;

  RETURN jsonb_build_object(
    'success', true,
    'already_authorized', false,
    'trigger_id', v_trigger.id,
    'payment_operation_id', v_payment_op_id,
    'provider_idempotency_key', v_idempotency_key,
    'recharge_amount_minor', v_trigger.recharge_amount_minor_snapshot,
    'currency', v_trigger.currency_snapshot
  );
END;
$$;

REVOKE ALL ON FUNCTION public.authorize_auto_topup_provider_mutation_atomic(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_auto_topup_provider_mutation_atomic(UUID, UUID) TO service_role;

