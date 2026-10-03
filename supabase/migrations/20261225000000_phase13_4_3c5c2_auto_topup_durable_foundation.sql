-- Migration: 20261225000000_phase13_4_3c5c2_auto_topup_durable_foundation.sql
-- Subphase C.5C.2: Durable Autonomous Charging Foundation (Remediated)
-- Description: Extends C.5B schema with threshold state, atomic generations, immutable trigger snapshots,
-- shared organization-level lock primitives, explicit structural payment operation FK relation, atomic claim,
-- re-arm, provider mutation authorization, and enrolment completion RPCs.

-- 1. EXTEND public.billing_auto_topup_settings
ALTER TABLE public.billing_auto_topup_settings
  ADD COLUMN IF NOT EXISTS threshold_state TEXT NOT NULL DEFAULT 'ARMED' CHECK (threshold_state IN ('ARMED', 'DISARMED')),
  ADD COLUMN IF NOT EXISTS configuration_generation INT NOT NULL DEFAULT 1 CHECK (configuration_generation >= 1),
  ADD COLUMN IF NOT EXISTS payment_authorization_generation INT NOT NULL DEFAULT 1 CHECK (payment_authorization_generation >= 1);

-- 2. EXTEND public.billing_payment_operations FOR STRUCTURAL TRIGGER RELATION
ALTER TABLE public.billing_payment_operations
  ADD COLUMN IF NOT EXISTS auto_topup_trigger_id UUID NULL REFERENCES public.billing_auto_topup_triggers(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_payment_ops_auto_topup_trigger_id
  ON public.billing_payment_operations (organization_id, auto_topup_trigger_id)
  WHERE auto_topup_trigger_id IS NOT NULL;

-- Drop obsolete metadata-only index if exists
DROP INDEX IF EXISTS idx_billing_payment_ops_auto_topup_trigger;

-- 3. EXTEND public.billing_auto_topup_triggers
ALTER TABLE public.billing_auto_topup_triggers DROP CONSTRAINT IF EXISTS billing_auto_topup_triggers_status_check;

ALTER TABLE public.billing_auto_topup_triggers
  ADD CONSTRAINT billing_auto_topup_triggers_status_check
  CHECK (status IN (
    'initiated',
    'claimed',
    'provider_mutation_authorized',
    'processing',
    'ambiguous',
    'requires_action',
    'provider_succeeded',
    'funding_pending',
    'funded',
    'failed',
    'cancelled_race',
    'cancelled_stale_generation',
    'manual_review_required'
  ));

ALTER TABLE public.billing_auto_topup_triggers
  ADD COLUMN IF NOT EXISTS configuration_generation_snapshot INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS payment_authorization_generation_snapshot INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS threshold_minor_snapshot BIGINT NOT NULL DEFAULT 1000 CHECK (threshold_minor_snapshot > 0),
  ADD COLUMN IF NOT EXISTS recharge_amount_minor_snapshot BIGINT NOT NULL DEFAULT 2500 CHECK (recharge_amount_minor_snapshot > 0),
  ADD COLUMN IF NOT EXISTS currency_snapshot TEXT NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS provider_account_id_snapshot UUID REFERENCES public.billing_provider_accounts(id),
  ADD COLUMN IF NOT EXISTS provider_customer_id_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS provider_payment_method_id_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS provider_idempotency_key TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempt_count INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN IF NOT EXISTS provider_payment_id TEXT;

CREATE INDEX IF NOT EXISTS idx_billing_auto_topup_triggers_status_lease
  ON public.billing_auto_topup_triggers(status, lease_expires_at);

-- 4. HELPER FUNCTION: GET AUTHORITATIVE SPENDABLE BALANCE MINOR
CREATE OR REPLACE FUNCTION public.get_spendable_credit_balance_minor(p_organization_id UUID)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_funded BIGINT := 0;
  v_reservations BIGINT := 0;
  v_holds BIGINT := 0;
  v_spendable BIGINT := 0;
BEGIN
  SELECT COALESCE(balance_after_minor, 0) INTO v_funded
  FROM public.billing_credit_ledger
  WHERE organization_id = p_organization_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  SELECT COALESCE(SUM(amount_reserved_minor), 0) INTO v_reservations
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id AND status = 'active';

  SELECT COALESCE(SUM(amount_minor), 0) INTO v_holds
  FROM public.billing_financial_holds
  WHERE organization_id = p_organization_id AND status = 'active';

  v_spendable := GREATEST(0, v_funded - v_reservations - v_holds);
  RETURN v_spendable;
END;
$$;

REVOKE ALL ON FUNCTION public.get_spendable_credit_balance_minor(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_spendable_credit_balance_minor(UUID) TO service_role;

-- 5. ATOMIC LOW-BALANCE CLAIM RPC PRIMITIVE
CREATE OR REPLACE FUNCTION public.claim_auto_topup_trigger_atomic(
  p_organization_id UUID,
  p_lease_owner TEXT DEFAULT 'worker_node'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_settings public.billing_auto_topup_settings;
  v_spendable BIGINT := 0;
  v_active_holds_count INT := 0;
  v_active_debts_count INT := 0;
  v_in_flight_count INT := 0;
  v_attempt_token UUID;
  v_trigger_id UUID;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS: p_organization_id is required.';
  END IF;

  -- 1. ENTRYWAY LOCK: Acquire shared organization serialization lock
  PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

  -- 2. Lock Auto Top-Up Settings
  SELECT * INTO v_settings
  FROM public.billing_auto_topup_settings
  WHERE organization_id = p_organization_id
  FOR UPDATE;

  IF v_settings.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'claimed', false, 'reason', 'SETTINGS_NOT_FOUND');
  END IF;

  IF v_settings.status <> 'enabled' THEN
    RETURN jsonb_build_object('success', false, 'claimed', false, 'reason', 'AUTO_TOPUP_NOT_ENABLED', 'status', v_settings.status);
  END IF;

  IF v_settings.threshold_state <> 'ARMED' THEN
    RETURN jsonb_build_object('success', false, 'claimed', false, 'reason', 'THRESHOLD_DISARMED');
  END IF;

  -- 3. Calculate Authoritative Spendable Balance
  v_spendable := public.get_spendable_credit_balance_minor(p_organization_id);

  IF v_spendable >= v_settings.threshold_minor THEN
    RETURN jsonb_build_object('success', false, 'claimed', false, 'reason', 'BALANCE_NOT_BELOW_THRESHOLD', 'spendable_minor', v_spendable, 'threshold_minor', v_settings.threshold_minor);
  END IF;

  -- 4. Check Risk States (Active Holds & Debts)
  SELECT COUNT(*) INTO v_active_holds_count
  FROM public.billing_financial_holds
  WHERE organization_id = p_organization_id AND status = 'active';

  IF v_active_holds_count > 0 THEN
    RETURN jsonb_build_object('success', false, 'claimed', false, 'reason', 'ACTIVE_FINANCIAL_HOLD_EXISTS');
  END IF;

  SELECT COUNT(*) INTO v_active_debts_count
  FROM public.billing_account_debts
  WHERE organization_id = p_organization_id AND status = 'unpaid';

  IF v_active_debts_count > 0 THEN
    RETURN jsonb_build_object('success', false, 'claimed', false, 'reason', 'ACTIVE_ACCOUNT_DEBT_EXISTS');
  END IF;

  -- 5. In-Flight Trigger Suppression Check
  SELECT COUNT(*) INTO v_in_flight_count
  FROM public.billing_auto_topup_triggers
  WHERE organization_id = p_organization_id
    AND status IN ('claimed', 'provider_mutation_authorized', 'processing', 'ambiguous', 'requires_action')
    AND (lease_expires_at IS NULL OR lease_expires_at > NOW());

  IF v_in_flight_count > 0 THEN
    RETURN jsonb_build_object('success', false, 'claimed', false, 'reason', 'IN_FLIGHT_TRIGGER_EXISTS');
  END IF;

  -- 6. Atomically Disarm Threshold State
  UPDATE public.billing_auto_topup_settings
  SET threshold_state = 'DISARMED',
      updated_at = NOW()
  WHERE id = v_settings.id;

  -- 7. Insert Claimed Trigger Row
  v_attempt_token := gen_random_uuid();

  INSERT INTO public.billing_auto_topup_triggers (
    organization_id,
    attempt_token,
    trigger_balance_minor,
    threshold_minor,
    recharge_amount_minor,
    status,
    configuration_generation_snapshot,
    payment_authorization_generation_snapshot,
    threshold_minor_snapshot,
    recharge_amount_minor_snapshot,
    currency_snapshot,
    provider_account_id_snapshot,
    provider_customer_id_snapshot,
    provider_payment_method_id_snapshot,
    lease_owner,
    lease_expires_at,
    attempt_count,
    created_at,
    updated_at
  ) VALUES (
    p_organization_id,
    v_attempt_token,
    v_spendable,
    v_settings.threshold_minor,
    v_settings.recharge_amount_minor,
    'claimed',
    v_settings.configuration_generation,
    v_settings.payment_authorization_generation,
    v_settings.threshold_minor,
    v_settings.recharge_amount_minor,
    v_settings.currency,
    v_settings.provider_account_id,
    v_settings.provider_customer_id,
    v_settings.provider_payment_method_id,
    p_lease_owner,
    NOW() + INTERVAL '15 minutes',
    1,
    NOW(),
    NOW()
  )
  RETURNING id INTO v_trigger_id;

  RETURN jsonb_build_object(
    'success', true,
    'claimed', true,
    'trigger_id', v_trigger_id,
    'attempt_token', v_attempt_token,
    'spendable_minor', v_spendable,
    'threshold_minor', v_settings.threshold_minor,
    'recharge_amount_minor', v_settings.recharge_amount_minor
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_auto_topup_trigger_atomic(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_auto_topup_trigger_atomic(UUID, TEXT) TO service_role;

-- 6. ATOMIC THRESHOLD RE-ARM EVALUATOR RPC
CREATE OR REPLACE FUNCTION public.rearm_auto_topup_threshold_atomic(p_organization_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_settings public.billing_auto_topup_settings;
  v_spendable BIGINT := 0;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS: p_organization_id is required.';
  END IF;

  -- 1. ENTRYWAY LOCK: Organization serialization lock
  PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

  -- 2. Lock Auto Top-Up Settings
  SELECT * INTO v_settings
  FROM public.billing_auto_topup_settings
  WHERE organization_id = p_organization_id
  FOR UPDATE;

  IF v_settings.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'rearmed', false, 'reason', 'SETTINGS_NOT_FOUND');
  END IF;

  IF v_settings.threshold_state <> 'DISARMED' THEN
    RETURN jsonb_build_object('success', true, 'rearmed', false, 'current_state', v_settings.threshold_state, 'reason', 'ALREADY_ARMED');
  END IF;

  -- 3. Compute Authoritative Spendable Balance
  v_spendable := public.get_spendable_credit_balance_minor(p_organization_id);

  -- Re-arm ONLY if spendable balance > threshold_minor (Strict inequality)
  IF v_spendable > v_settings.threshold_minor THEN
    UPDATE public.billing_auto_topup_settings
    SET threshold_state = 'ARMED',
        updated_at = NOW()
    WHERE id = v_settings.id;

    RETURN jsonb_build_object(
      'success', true,
      'rearmed', true,
      'previous_state', 'DISARMED',
      'current_state', 'ARMED',
      'spendable_minor', v_spendable,
      'threshold_minor', v_settings.threshold_minor
    );
  ELSE
    RETURN jsonb_build_object(
      'success', true,
      'rearmed', false,
      'current_state', 'DISARMED',
      'spendable_minor', v_spendable,
      'threshold_minor', v_settings.threshold_minor,
      'reason', 'SPENDABLE_NOT_GREATER_THAN_THRESHOLD'
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.rearm_auto_topup_threshold_atomic(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rearm_auto_topup_threshold_atomic(UUID) TO service_role;

-- 7. ATOMIC PROVIDER-MUTATION AUTHORIZATION RPC (IRREVERSIBLE LOCAL AUTHORIZATION BOUNDARY)
CREATE OR REPLACE FUNCTION public.authorize_auto_topup_provider_mutation_atomic(
  p_organization_id UUID,
  p_trigger_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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

  -- 1. ENTRYWAY LOCK: Organization serialization lock
  PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

  -- 2. Lock Auto Top-Up Settings
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

  -- 3. Lock Trigger Row
  SELECT * INTO v_trigger
  FROM public.billing_auto_topup_triggers
  WHERE id = p_trigger_id AND organization_id = p_organization_id
  FOR UPDATE;

  IF v_trigger.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'authorized', false, 'reason', 'TRIGGER_NOT_FOUND');
  END IF;

  -- Idempotency check: Already authorized
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

  -- 4. Verify Snapshot Generations
  IF v_trigger.configuration_generation_snapshot <> v_settings.configuration_generation OR
     v_trigger.payment_authorization_generation_snapshot <> v_settings.payment_authorization_generation THEN

    UPDATE public.billing_auto_topup_triggers
    SET status = 'cancelled_stale_generation',
        error_code = 'STALE_GENERATION_MISMATCH',
        updated_at = NOW()
    WHERE id = v_trigger.id;

    RETURN jsonb_build_object('success', false, 'authorized', false, 'reason', 'STALE_GENERATION_MISMATCH');
  END IF;

  -- 5. Re-verify Spendable Balance
  v_spendable := public.get_spendable_credit_balance_minor(p_organization_id);
  IF v_spendable >= v_settings.threshold_minor THEN
    UPDATE public.billing_auto_topup_triggers
    SET status = 'cancelled_race',
        error_code = 'FUNDED_BEFORE_AUTHORIZATION',
        updated_at = NOW()
    WHERE id = v_trigger.id;

    RETURN jsonb_build_object('success', false, 'authorized', false, 'reason', 'FUNDED_BEFORE_AUTHORIZATION');
  END IF;

  -- 6. Re-verify Risk State
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

  -- 7. Create/Recover Payment Operation with Explicit auto_topup_trigger_id FK Relation
  v_idempotency_key := 'atu_pi_' || v_trigger.id::text;
  v_request_fingerprint := 'sha256:' || encode(digest('auto_topup:' || v_trigger.id::text, 'sha256'), 'hex');

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
  ON CONFLICT (organization_id, auto_topup_trigger_id) WHERE auto_topup_trigger_id IS NOT NULL
  DO UPDATE SET updated_at = NOW()
  RETURNING id INTO v_payment_op_id;

  IF v_payment_op_id IS NULL THEN
    SELECT id INTO v_payment_op_id
    FROM public.billing_payment_operations
    WHERE organization_id = p_organization_id AND auto_topup_trigger_id = v_trigger.id;
  END IF;

  -- 8. IRREVERSIBLE LOCAL AUTHORIZATION COMMIT
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

-- 8. UPDATED C.5B ENROLMENT COMPLETION RPC WITH GENERATION ADVANCE LOGIC
CREATE OR REPLACE FUNCTION public.complete_auto_topup_enrolment_atomic(
  p_organization_id UUID,
  p_attempt_token UUID,
  p_setup_intent_id TEXT,
  p_provider_payment_method_id TEXT,
  p_payment_method_brand TEXT,
  p_payment_method_last4 TEXT,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attempt public.billing_auto_topup_attempts;
  v_settings public.billing_auto_topup_settings;
  v_newer_attempt_exists BOOLEAN := FALSE;
  v_next_config_gen INT := 1;
  v_next_auth_gen INT := 1;
BEGIN
  IF p_organization_id IS NULL OR p_attempt_token IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS: p_organization_id and p_attempt_token are required.';
  END IF;

  -- Lock organization for atomic settings updates
  PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

  -- Fetch enrolment attempt
  SELECT * INTO v_attempt
  FROM public.billing_auto_topup_attempts
  WHERE attempt_token = p_attempt_token AND organization_id = p_organization_id
  FOR UPDATE;

  IF v_attempt.id IS NULL THEN
    RAISE EXCEPTION 'ENROLMENT_ATTEMPT_NOT_FOUND: Attempt % for org % does not exist.', p_attempt_token, p_organization_id;
  END IF;

  -- Lock current settings if existing
  SELECT * INTO v_settings
  FROM public.billing_auto_topup_settings
  WHERE organization_id = p_organization_id
  FOR UPDATE;

  -- IDEMPOTENCY CHECK: Replaying the SAME already-completed enrolment attempt MUST NOT advance generations!
  IF v_attempt.status = 'completed' AND v_settings.provider_payment_method_id = p_provider_payment_method_id THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_completed', true,
      'status', v_settings.status,
      'organization_id', p_organization_id,
      'configuration_generation', v_settings.configuration_generation,
      'payment_authorization_generation', v_settings.payment_authorization_generation
    );
  END IF;

  -- 1. Stale Enrolment Race Check
  SELECT EXISTS (
    SELECT 1 FROM public.billing_auto_topup_attempts
    WHERE organization_id = p_organization_id
      AND created_at > v_attempt.created_at
      AND status IN ('setup_created', 'completed')
  ) INTO v_newer_attempt_exists;

  IF v_newer_attempt_exists THEN
    RAISE EXCEPTION 'STALE_ENROLMENT: A newer enrolment attempt supersedes this attempt.';
  END IF;

  -- 2. Disable Race Check
  IF v_settings.id IS NOT NULL AND v_settings.disabled_at IS NOT NULL AND v_settings.disabled_at > v_attempt.created_at THEN
    RAISE EXCEPTION 'ENROLMENT_SUPERSEDED_BY_DISABLE: Auto Top-Up was disabled after this attempt was initiated.';
  END IF;

  -- Determine Generation Advances for NEW Completion
  IF v_settings.id IS NOT NULL THEN
    -- If threshold or recharge amount changed, advance configuration_generation
    IF v_settings.threshold_minor <> v_attempt.threshold_minor OR v_settings.recharge_amount_minor <> v_attempt.recharge_amount_minor THEN
      v_next_config_gen := COALESCE(v_settings.configuration_generation, 1) + 1;
    ELSE
      v_next_config_gen := COALESCE(v_settings.configuration_generation, 1);
    END IF;

    -- If payment method, provider account, or enabled status changed, advance payment_authorization_generation
    IF v_settings.provider_payment_method_id <> p_provider_payment_method_id OR
       v_settings.provider_account_id <> v_attempt.provider_account_id OR
       v_settings.status <> 'enabled' THEN
      v_next_auth_gen := COALESCE(v_settings.payment_authorization_generation, 1) + 1;
    ELSE
      v_next_auth_gen := COALESCE(v_settings.payment_authorization_generation, 1);
    END IF;
  ELSE
    v_next_config_gen := 1;
    v_next_auth_gen := 1;
  END IF;

  -- Mark attempt as completed
  UPDATE public.billing_auto_topup_attempts
  SET status = 'completed',
      setup_intent_id = COALESCE(p_setup_intent_id, setup_intent_id),
      updated_at = NOW()
  WHERE id = v_attempt.id;

  -- Mark older attempts as superseded
  UPDATE public.billing_auto_topup_attempts
  SET status = 'superseded',
      updated_at = NOW()
  WHERE organization_id = p_organization_id
    AND id <> v_attempt.id
    AND status IN ('initiated', 'setup_created');

  -- Upsert active settings with generation advances
  INSERT INTO public.billing_auto_topup_settings (
    organization_id, status, threshold_minor, recharge_amount_minor, currency,
    provider_account_id, provider_customer_id, provider_payment_method_id,
    payment_method_brand, payment_method_last4, enrolled_by_user_id, enrolled_at,
    consent_terms_version, failure_count, disabled_at, disabled_by_user_id, disabled_reason,
    configuration_generation, payment_authorization_generation, updated_at
  ) VALUES (
    p_organization_id, 'enabled', v_attempt.threshold_minor, v_attempt.recharge_amount_minor, v_attempt.currency,
    v_attempt.provider_account_id, v_attempt.provider_customer_id, p_provider_payment_method_id,
    p_payment_method_brand, p_payment_method_last4, p_user_id, NOW(),
    'v1.0', 0, NULL, NULL, NULL,
    v_next_config_gen, v_next_auth_gen, NOW()
  )
  ON CONFLICT (organization_id) DO UPDATE
  SET status = 'enabled',
      threshold_minor = EXCLUDED.threshold_minor,
      recharge_amount_minor = EXCLUDED.recharge_amount_minor,
      currency = EXCLUDED.currency,
      provider_account_id = EXCLUDED.provider_account_id,
      provider_customer_id = EXCLUDED.provider_customer_id,
      provider_payment_method_id = EXCLUDED.provider_payment_method_id,
      payment_method_brand = EXCLUDED.payment_method_brand,
      payment_method_last4 = EXCLUDED.payment_method_last4,
      enrolled_by_user_id = EXCLUDED.enrolled_by_user_id,
      enrolled_at = EXCLUDED.enrolled_at,
      consent_terms_version = EXCLUDED.consent_terms_version,
      failure_count = 0,
      disabled_at = NULL,
      disabled_by_user_id = NULL,
      disabled_reason = NULL,
      configuration_generation = EXCLUDED.configuration_generation,
      payment_authorization_generation = EXCLUDED.payment_authorization_generation,
      updated_at = NOW();

  RETURN jsonb_build_object(
    'success', true,
    'already_completed', false,
    'status', 'enabled',
    'organization_id', p_organization_id,
    'configuration_generation', v_next_config_gen,
    'payment_authorization_generation', v_next_auth_gen
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_auto_topup_enrolment_atomic(UUID, UUID, TEXT, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_auto_topup_enrolment_atomic(UUID, UUID, TEXT, TEXT, TEXT, TEXT, UUID) TO service_role;

-- Comments
COMMENT ON FUNCTION public.claim_auto_topup_trigger_atomic IS 'Phase 13.4.3C C.5C.2 Remediated low-balance trigger claim with org locking and threshold state disarming.';
COMMENT ON FUNCTION public.rearm_auto_topup_threshold_atomic IS 'Phase 13.4.3C C.5C.2 Atomic threshold re-arm evaluator enforcing spendable_balance > threshold_minor.';
COMMENT ON FUNCTION public.authorize_auto_topup_provider_mutation_atomic IS 'Phase 13.4.3C C.5C.2 Irreversible local provider mutation authorization RPC with structural trigger FK relation.';
COMMENT ON FUNCTION public.complete_auto_topup_enrolment_atomic IS 'Phase 13.4.3C C.5C.2 Remediated enrolment completion RPC advancing authorization and configuration generations.';
