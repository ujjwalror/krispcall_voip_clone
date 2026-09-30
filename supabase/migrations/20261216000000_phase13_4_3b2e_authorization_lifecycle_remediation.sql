-- supabase/migrations/20261216000000_phase13_4_3b2e_authorization_lifecycle_remediation.sql
-- Phase 13.4.3B.2E Experiment Authorization Lifecycle Remediation (ARMED -> CLAIMED -> CONSUMED)

-- 1. Alter check constraint to support 'claimed' state
ALTER TABLE public.telecom_experiment_authorizations
DROP CONSTRAINT IF EXISTS telecom_experiment_authorizations_status_check;

ALTER TABLE public.telecom_experiment_authorizations
ADD CONSTRAINT telecom_experiment_authorizations_status_check 
CHECK (status IN ('armed', 'claimed', 'consumed', 'expired', 'cancelled'));

-- 2. Add claimed_at and claim_expires_at columns if they do not exist
ALTER TABLE public.telecom_experiment_authorizations
ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;

-- 3. RPC: claim_telecom_experiment_authorization_atomic
CREATE OR REPLACE FUNCTION public.claim_telecom_experiment_authorization_atomic(
  p_organization_id UUID,
  p_call_id UUID,
  p_destination_fingerprint TEXT,
  p_claim_lease_seconds INT DEFAULT 60
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_record RECORD;
  v_norm_fp TEXT;
  v_claim_expires_at TIMESTAMPTZ;
BEGIN
  v_norm_fp := trim(p_destination_fingerprint);
  v_claim_expires_at := NOW() + (p_claim_lease_seconds || ' seconds')::INTERVAL;

  IF v_norm_fp IS NULL OR length(v_norm_fp) = 0 THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'reason', 'INVALID_DESTINATION_FINGERPRINT'
    );
  END IF;

  -- Step A: Reclaim expired claims whose parent authorization is still valid
  UPDATE public.telecom_experiment_authorizations
  SET status = 'armed',
      bound_call_id = NULL,
      claimed_at = NULL,
      claim_expires_at = NULL,
      updated_at = NOW()
  WHERE organization_id = p_organization_id
    AND destination_fingerprint = v_norm_fp
    AND status = 'claimed'
    AND claim_expires_at <= NOW()
    AND expires_at > NOW();

  -- Step B: Atomic selection of active armed authorization
  SELECT * INTO v_record
  FROM public.telecom_experiment_authorizations
  WHERE organization_id = p_organization_id
    AND destination_fingerprint = v_norm_fp
    AND status = 'armed'
    AND expires_at > NOW()
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_record.id IS NULL THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'reason', 'NO_ARMED_AUTHORIZATION_FOUND'
    );
  END IF;

  UPDATE public.telecom_experiment_authorizations
  SET status = 'claimed',
      bound_call_id = p_call_id,
      claimed_at = NOW(),
      claim_expires_at = v_claim_expires_at,
      updated_at = NOW()
  WHERE id = v_record.id;

  RETURN jsonb_build_object(
    'claimed', true,
    'authorization_id', v_record.id,
    'organization_id', v_record.organization_id,
    'bound_call_id', p_call_id,
    'initial_exposure_seconds', v_record.initial_exposure_seconds,
    'max_initial_exposure_seconds', v_record.max_initial_exposure_seconds,
    'enforcement_mode', v_record.enforcement_mode,
    'claim_expires_at', v_claim_expires_at
  );
END;
$$;

-- 4. RPC: consume_telecom_experiment_authorization_atomic
CREATE OR REPLACE FUNCTION public.consume_telecom_experiment_authorization_atomic(
  p_organization_id UUID,
  p_call_id UUID,
  p_destination_fingerprint TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_record RECORD;
  v_norm_fp TEXT;
BEGIN
  v_norm_fp := trim(p_destination_fingerprint);

  IF v_norm_fp IS NULL OR length(v_norm_fp) = 0 THEN
    RETURN jsonb_build_object(
      'consumed', false,
      'reason', 'INVALID_DESTINATION_FINGERPRINT'
    );
  END IF;

  -- Atomic lock on matching claimed or consumed authorization bound to this call_id
  SELECT * INTO v_record
  FROM public.telecom_experiment_authorizations
  WHERE organization_id = p_organization_id
    AND destination_fingerprint = v_norm_fp
    AND bound_call_id = p_call_id
    AND status IN ('claimed', 'consumed')
    AND expires_at > NOW()
  FOR UPDATE;

  IF v_record.id IS NULL THEN
    RETURN jsonb_build_object(
      'consumed', false,
      'reason', 'NO_CLAIMED_AUTHORIZATION_FOUND'
    );
  END IF;

  -- Idempotency check for duplicate webhook delivery
  IF v_record.status = 'consumed' THEN
    RETURN jsonb_build_object(
      'consumed', true,
      'is_duplicate', true,
      'authorization_id', v_record.id,
      'organization_id', v_record.organization_id,
      'bound_call_id', p_call_id,
      'initial_exposure_seconds', v_record.initial_exposure_seconds,
      'max_initial_exposure_seconds', v_record.max_initial_exposure_seconds,
      'enforcement_mode', v_record.enforcement_mode
    );
  END IF;

  -- Check if claim lease expired
  IF v_record.claim_expires_at IS NOT NULL AND v_record.claim_expires_at <= NOW() THEN
    RETURN jsonb_build_object(
      'consumed', false,
      'reason', 'CLAIM_EXPIRED'
    );
  END IF;

  -- Transition CLAIMED -> CONSUMED
  UPDATE public.telecom_experiment_authorizations
  SET status = 'consumed',
      updated_at = NOW()
  WHERE id = v_record.id;

  RETURN jsonb_build_object(
    'consumed', true,
    'is_duplicate', false,
    'authorization_id', v_record.id,
    'organization_id', v_record.organization_id,
    'bound_call_id', p_call_id,
    'initial_exposure_seconds', v_record.initial_exposure_seconds,
    'max_initial_exposure_seconds', v_record.max_initial_exposure_seconds,
    'enforcement_mode', v_record.enforcement_mode
  );
END;
$$;

-- Permissions
REVOKE ALL ON FUNCTION public.claim_telecom_experiment_authorization_atomic(UUID, UUID, TEXT, INT) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.claim_telecom_experiment_authorization_atomic(UUID, UUID, TEXT, INT) TO service_role;

REVOKE ALL ON FUNCTION public.consume_telecom_experiment_authorization_atomic(UUID, UUID, TEXT) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.consume_telecom_experiment_authorization_atomic(UUID, UUID, TEXT) TO service_role;
