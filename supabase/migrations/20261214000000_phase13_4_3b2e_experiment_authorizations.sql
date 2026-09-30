-- supabase/migrations/20261214000000_phase13_4_3b2e_experiment_authorizations.sql
-- Phase 13.4.3B.2E Experiment Authorization Primitives (Server-Authoritative Per-Call Policy)

CREATE TABLE IF NOT EXISTS public.telecom_experiment_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  destination_number TEXT NOT NULL,
  initial_exposure_seconds INT NOT NULL DEFAULT 30 CHECK (initial_exposure_seconds >= 10 AND initial_exposure_seconds <= 3600),
  max_initial_exposure_seconds INT NOT NULL DEFAULT 300 CHECK (max_initial_exposure_seconds >= 30 AND max_initial_exposure_seconds <= 7200),
  enforcement_mode TEXT NOT NULL DEFAULT 'enforce' CHECK (enforcement_mode IN ('disabled', 'shadow_log', 'enforce')),
  status TEXT NOT NULL DEFAULT 'armed' CHECK (status IN ('armed', 'consumed', 'expired', 'cancelled')),
  bound_call_id UUID REFERENCES public.calls(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial UNIQUE index to ensure a call can be bound to at most ONE experiment authorization
CREATE UNIQUE INDEX IF NOT EXISTS uq_telecom_exp_auth_bound_call_id 
ON public.telecom_experiment_authorizations (bound_call_id) 
WHERE bound_call_id IS NOT NULL;

-- Index for fast lookup by organization, destination, status, and expiry
CREATE INDEX IF NOT EXISTS idx_telecom_exp_auth_org_dest_status 
ON public.telecom_experiment_authorizations (organization_id, destination_number, status, expires_at);

-- Enable Row Level Security
ALTER TABLE public.telecom_experiment_authorizations ENABLE ROW LEVEL SECURITY;

-- Allow service_role full access
DROP POLICY IF EXISTS "Service role full access to telecom_experiment_authorizations" ON public.telecom_experiment_authorizations;
CREATE POLICY "Service role full access to telecom_experiment_authorizations" 
ON public.telecom_experiment_authorizations 
FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Allow authenticated organization members read access to their own org authorizations
DROP POLICY IF EXISTS "Org members can read own experiment authorizations" ON public.telecom_experiment_authorizations;
CREATE POLICY "Org members can read own experiment authorizations" 
ON public.telecom_experiment_authorizations 
FOR SELECT TO authenticated 
USING (
  organization_id IN (
    SELECT organization_id FROM public.profiles WHERE id = auth.uid()
  )
);

-- RPC: arm_telecom_experiment_authorization_atomic
CREATE OR REPLACE FUNCTION public.arm_telecom_experiment_authorization_atomic(
  p_organization_id UUID,
  p_destination_number TEXT,
  p_initial_exposure_seconds INT DEFAULT 30,
  p_max_initial_exposure_seconds INT DEFAULT 300,
  p_enforcement_mode TEXT DEFAULT 'enforce',
  p_ttl_seconds INT DEFAULT 600
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_auth_id UUID;
  v_expires_at TIMESTAMPTZ;
  v_norm_dest TEXT;
BEGIN
  v_norm_dest := trim(p_destination_number);
  v_expires_at := NOW() + (p_ttl_seconds || ' seconds')::INTERVAL;

  -- Mark expired any prior armed authorizations for this org/destination
  UPDATE public.telecom_experiment_authorizations
  SET status = 'expired', updated_at = NOW()
  WHERE organization_id = p_organization_id
    AND destination_number = v_norm_dest
    AND status = 'armed'
    AND expires_at <= NOW();

  INSERT INTO public.telecom_experiment_authorizations (
    organization_id,
    destination_number,
    initial_exposure_seconds,
    max_initial_exposure_seconds,
    enforcement_mode,
    status,
    expires_at
  ) VALUES (
    p_organization_id,
    v_norm_dest,
    p_initial_exposure_seconds,
    p_max_initial_exposure_seconds,
    p_enforcement_mode,
    'armed',
    v_expires_at
  ) RETURNING id INTO v_auth_id;

  RETURN jsonb_build_object(
    'success', true,
    'authorization_id', v_auth_id,
    'organization_id', p_organization_id,
    'destination_number', v_norm_dest,
    'initial_exposure_seconds', p_initial_exposure_seconds,
    'enforcement_mode', p_enforcement_mode,
    'expires_at', v_expires_at
  );
END;
$$;

-- RPC: consume_telecom_experiment_authorization_atomic
CREATE OR REPLACE FUNCTION public.consume_telecom_experiment_authorization_atomic(
  p_organization_id UUID,
  p_call_id UUID,
  p_destination_number TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_record RECORD;
  v_norm_dest TEXT;
BEGIN
  v_norm_dest := trim(p_destination_number);

  -- Atomic claim using FOR UPDATE SKIP LOCKED on oldest armed valid matching authorization
  SELECT * INTO v_record
  FROM public.telecom_experiment_authorizations
  WHERE organization_id = p_organization_id
    AND destination_number = v_norm_dest
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

  -- Transition status to consumed & bind call ID
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
