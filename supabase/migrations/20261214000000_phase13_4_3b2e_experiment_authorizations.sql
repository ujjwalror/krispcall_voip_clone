-- supabase/migrations/20261214000000_phase13_4_3b2e_experiment_authorizations.sql
-- Phase 13.4.3B.2E Experiment Authorization Primitives (Hardened Server-Authoritative Per-Call Policy)

CREATE TABLE IF NOT EXISTS public.telecom_experiment_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  destination_fingerprint TEXT NOT NULL,
  initial_exposure_seconds INT NOT NULL DEFAULT 30 CHECK (initial_exposure_seconds >= 10 AND initial_exposure_seconds <= 3600),
  max_initial_exposure_seconds INT NOT NULL DEFAULT 300 CHECK (max_initial_exposure_seconds >= 30 AND max_initial_exposure_seconds <= 7200),
  enforcement_mode TEXT NOT NULL DEFAULT 'enforce' CHECK (enforcement_mode = 'enforce'),
  status TEXT NOT NULL DEFAULT 'armed' CHECK (status IN ('armed', 'consumed', 'expired', 'cancelled')),
  bound_call_id UUID REFERENCES public.calls(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_telecom_exp_exposure_bounds CHECK (initial_exposure_seconds <= max_initial_exposure_seconds)
);

-- Partial UNIQUE index to ensure a call can be bound to at most ONE experiment authorization
CREATE UNIQUE INDEX IF NOT EXISTS uq_telecom_exp_auth_bound_call_id 
ON public.telecom_experiment_authorizations (bound_call_id) 
WHERE bound_call_id IS NOT NULL;

-- Index for fast lookup by organization, fingerprint, status, and expiry
CREATE INDEX IF NOT EXISTS idx_telecom_exp_auth_org_fp_status 
ON public.telecom_experiment_authorizations (organization_id, destination_fingerprint, status, expires_at);

-- Enable Row Level Security (Service Role Only)
ALTER TABLE public.telecom_experiment_authorizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access to telecom_experiment_authorizations" ON public.telecom_experiment_authorizations;
CREATE POLICY "Service role full access to telecom_experiment_authorizations" 
ON public.telecom_experiment_authorizations 
FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Revoke all access from public, authenticated, and anon roles (service_role only)
REVOKE ALL ON public.telecom_experiment_authorizations FROM PUBLIC, authenticated, anon;
GRANT ALL ON public.telecom_experiment_authorizations TO service_role;

-- RPC: arm_telecom_experiment_authorization_atomic
CREATE OR REPLACE FUNCTION public.arm_telecom_experiment_authorization_atomic(
  p_organization_id UUID,
  p_destination_fingerprint TEXT,
  p_initial_exposure_seconds INT DEFAULT 30,
  p_max_initial_exposure_seconds INT DEFAULT 300,
  p_ttl_seconds INT DEFAULT 600
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_auth_id UUID;
  v_expires_at TIMESTAMPTZ;
  v_norm_fp TEXT;
BEGIN
  v_norm_fp := trim(p_destination_fingerprint);
  v_expires_at := NOW() + (p_ttl_seconds || ' seconds')::INTERVAL;

  IF v_norm_fp IS NULL OR length(v_norm_fp) = 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason', 'INVALID_DESTINATION_FINGERPRINT'
    );
  END IF;

  IF p_initial_exposure_seconds > p_max_initial_exposure_seconds THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason', 'EXPOSURE_BOUNDS_VIOLATION'
    );
  END IF;

  -- Expire prior armed authorizations for same org & fingerprint
  UPDATE public.telecom_experiment_authorizations
  SET status = 'expired', updated_at = NOW()
  WHERE organization_id = p_organization_id
    AND destination_fingerprint = v_norm_fp
    AND status = 'armed'
    AND expires_at <= NOW();

  INSERT INTO public.telecom_experiment_authorizations (
    organization_id,
    destination_fingerprint,
    initial_exposure_seconds,
    max_initial_exposure_seconds,
    enforcement_mode,
    status,
    expires_at
  ) VALUES (
    p_organization_id,
    v_norm_fp,
    p_initial_exposure_seconds,
    p_max_initial_exposure_seconds,
    'enforce',
    'armed',
    v_expires_at
  ) RETURNING id INTO v_auth_id;

  RETURN jsonb_build_object(
    'success', true,
    'authorization_id', v_auth_id,
    'organization_id', p_organization_id,
    'initial_exposure_seconds', p_initial_exposure_seconds,
    'enforcement_mode', 'enforce',
    'expires_at', v_expires_at
  );
END;
$$;

-- RPC: consume_telecom_experiment_authorization_atomic
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

  -- Atomic claim using FOR UPDATE SKIP LOCKED
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
      'consumed', false,
      'reason', 'NO_ARMED_AUTHORIZATION_FOUND'
    );
  END IF;

  UPDATE public.telecom_experiment_authorizations
  SET status = 'consumed',
      bound_call_id = p_call_id,
      updated_at = NOW()
  WHERE id = v_record.id;

  RETURN jsonb_build_object(
    'consumed', true,
    'authorization_id', v_record.id,
    'organization_id', v_record.organization_id,
    'bound_call_id', p_call_id,
    'initial_exposure_seconds', v_record.initial_exposure_seconds,
    'max_initial_exposure_seconds', v_record.max_initial_exposure_seconds,
    'enforcement_mode', v_record.enforcement_mode
  );
END;
$$;
