-- Migration: 20261224000000_phase13_4_3c5b_auto_topup_foundation.sql
-- Subphase C.5B: Auto Top-Up Enrolment & Configuration Foundation (Remediated)
-- Description: Creates durable tables and atomic RPC primitives for Auto Top-Up enrolment, settings, and trigger tracking.

-- 1. Create public.billing_auto_topup_settings
CREATE TABLE IF NOT EXISTS public.billing_auto_topup_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled', 'enabled', 'action_required', 'paused_failure', 'paused_debt', 'paused_dispute')),
  threshold_minor BIGINT NOT NULL CHECK (threshold_minor > 0),
  recharge_amount_minor BIGINT NOT NULL CHECK (recharge_amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  provider_account_id UUID NOT NULL REFERENCES public.billing_provider_accounts(id),
  provider_customer_id TEXT NOT NULL,
  provider_payment_method_id TEXT NOT NULL,
  payment_method_brand TEXT,
  payment_method_last4 TEXT,
  enrolled_by_user_id UUID REFERENCES auth.users(id),
  enrolled_at TIMESTAMPTZ,
  consent_terms_version TEXT NOT NULL DEFAULT 'v1.0',
  disabled_at TIMESTAMPTZ,
  disabled_by_user_id UUID REFERENCES auth.users(id),
  disabled_reason TEXT,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  failure_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for organization lookup
CREATE INDEX IF NOT EXISTS idx_billing_auto_topup_settings_org
  ON public.billing_auto_topup_settings(organization_id);

-- 2. Create public.billing_auto_topup_attempts (Durable Enrolment Attempts)
CREATE TABLE IF NOT EXISTS public.billing_auto_topup_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  attempt_token UUID NOT NULL UNIQUE,
  provider_account_id UUID NOT NULL REFERENCES public.billing_provider_accounts(id),
  provider_customer_id TEXT NOT NULL,
  setup_intent_id TEXT,
  threshold_minor BIGINT NOT NULL CHECK (threshold_minor > 0),
  recharge_amount_minor BIGINT NOT NULL CHECK (recharge_amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  initiated_by_user_id UUID REFERENCES auth.users(id),
  status TEXT NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated', 'setup_created', 'completed', 'superseded', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_auto_topup_attempts_org
  ON public.billing_auto_topup_attempts(organization_id);

CREATE INDEX IF NOT EXISTS idx_billing_auto_topup_attempts_token
  ON public.billing_auto_topup_attempts(attempt_token);

-- 3. Create public.billing_auto_topup_triggers
CREATE TABLE IF NOT EXISTS public.billing_auto_topup_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  attempt_token UUID UNIQUE NOT NULL,
  payment_operation_id UUID REFERENCES public.billing_payment_operations(id),
  trigger_balance_minor BIGINT NOT NULL CHECK (trigger_balance_minor >= 0),
  threshold_minor BIGINT NOT NULL CHECK (threshold_minor > 0),
  recharge_amount_minor BIGINT NOT NULL CHECK (recharge_amount_minor > 0),
  status TEXT NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated', 'processing', 'succeeded', 'requires_action', 'failed', 'cancelled_race')),
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_auto_topup_triggers_org
  ON public.billing_auto_topup_triggers(organization_id);

-- 4. PRIVILEGE AUDIT & CONFIDENTIALITY ENFORCEMENT
-- Enable RLS on all tables
ALTER TABLE public.billing_auto_topup_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_auto_topup_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_auto_topup_triggers ENABLE ROW LEVEL SECURITY;

-- REVOKE all table privileges from PUBLIC, anon, and authenticated roles
REVOKE ALL ON public.billing_auto_topup_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.billing_auto_topup_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.billing_auto_topup_triggers FROM PUBLIC, anon, authenticated;

-- GRANT full privileges exclusively to service_role
GRANT ALL ON public.billing_auto_topup_settings TO service_role;
GRANT ALL ON public.billing_auto_topup_attempts TO service_role;
GRANT ALL ON public.billing_auto_topup_triggers TO service_role;

-- Service role RLS policies
CREATE POLICY auto_topup_settings_service_role ON public.billing_auto_topup_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY auto_topup_attempts_service_role ON public.billing_auto_topup_attempts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY auto_topup_triggers_service_role ON public.billing_auto_topup_triggers
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 5. ATOMIC COMPLETION RPC PRIMITIVE
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

  -- Check if attempt was already completed (Idempotency)
  IF v_attempt.status = 'completed' AND v_settings.provider_payment_method_id = p_provider_payment_method_id THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_completed', true,
      'status', v_settings.status,
      'organization_id', p_organization_id
    );
  END IF;

  -- 1. Stale Enrolment Race Check: Check if a newer attempt for this org was created after this attempt
  SELECT EXISTS (
    SELECT 1 FROM public.billing_auto_topup_attempts
    WHERE organization_id = p_organization_id
      AND created_at > v_attempt.created_at
      AND status IN ('setup_created', 'completed')
  ) INTO v_newer_attempt_exists;

  IF v_newer_attempt_exists THEN
    RAISE EXCEPTION 'STALE_ENROLMENT: A newer enrolment attempt supersedes this attempt.';
  END IF;

  -- 2. Disable Race Check: Check if settings were explicitly disabled AFTER this attempt was created
  IF v_settings.id IS NOT NULL AND v_settings.disabled_at IS NOT NULL AND v_settings.disabled_at > v_attempt.created_at THEN
    RAISE EXCEPTION 'ENROLMENT_SUPERSEDED_BY_DISABLE: Auto Top-Up was disabled after this attempt was initiated.';
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

  -- Upsert active settings
  INSERT INTO public.billing_auto_topup_settings (
    organization_id, status, threshold_minor, recharge_amount_minor, currency,
    provider_account_id, provider_customer_id, provider_payment_method_id,
    payment_method_brand, payment_method_last4, enrolled_by_user_id, enrolled_at,
    consent_terms_version, failure_count, disabled_at, disabled_by_user_id, disabled_reason, updated_at
  ) VALUES (
    p_organization_id, 'enabled', v_attempt.threshold_minor, v_attempt.recharge_amount_minor, v_attempt.currency,
    v_attempt.provider_account_id, v_attempt.provider_customer_id, p_provider_payment_method_id,
    p_payment_method_brand, p_payment_method_last4, p_user_id, NOW(),
    'v1.0', 0, NULL, NULL, NULL, NOW()
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
      updated_at = NOW();

  RETURN jsonb_build_object(
    'success', true,
    'already_completed', false,
    'status', 'enabled',
    'organization_id', p_organization_id
  );
END;
$$;

-- Restrict RPC execution to service_role ONLY
REVOKE ALL ON FUNCTION public.complete_auto_topup_enrolment_atomic(UUID, UUID, TEXT, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_auto_topup_enrolment_atomic(UUID, UUID, TEXT, TEXT, TEXT, TEXT, UUID) TO service_role;

-- Comments
COMMENT ON TABLE public.billing_auto_topup_settings IS 'Phase 13.4.3C C.5B Remediated Auto Top-Up consent settings and saved off-session payment method references.';
COMMENT ON TABLE public.billing_auto_topup_attempts IS 'Phase 13.4.3C C.5B Durable Auto Top-Up enrolment attempt state machine and race protection.';
COMMENT ON TABLE public.billing_auto_topup_triggers IS 'Phase 13.4.3C C.5B Auto Top-Up trigger attempt lifecycle and idempotency tracking.';
COMMENT ON FUNCTION public.complete_auto_topup_enrolment_atomic IS 'Phase 13.4.3C C.5B Atomic database completion primitive protecting against stale enrolment and disable races.';
