-- supabase/migrations/20261217000000_phase13_4_3b2e_runner_heartbeats.sql
-- Phase 13.4.3B.2E Local Controlled Runner Heartbeat Registry (Server-Authoritative Readiness Handshake)

CREATE TABLE IF NOT EXISTS public.telecom_runner_heartbeats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  runner_id TEXT NOT NULL,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  authorization_id UUID REFERENCES public.telecom_experiment_authorizations(id) ON DELETE CASCADE,
  destination_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'WAITING_FOR_CALL' CHECK (status IN ('STARTING', 'WAITING_FOR_CALL', 'MONITORING_CALL', 'EXECUTING_EXTENSION', 'TERMINATING_CALL', 'COMPLETED', 'STOPPED', 'FAILED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast lookup by org, authorization, fingerprint, and freshness
CREATE INDEX IF NOT EXISTS idx_telecom_runner_hb_auth_org_fp 
ON public.telecom_runner_heartbeats (organization_id, authorization_id, destination_fingerprint, status, expires_at);

-- Enable Row Level Security (Service Role Only)
ALTER TABLE public.telecom_runner_heartbeats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access to telecom_runner_heartbeats" ON public.telecom_runner_heartbeats;
CREATE POLICY "Service role full access to telecom_runner_heartbeats" 
ON public.telecom_runner_heartbeats 
FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.telecom_runner_heartbeats FROM PUBLIC, authenticated, anon;
GRANT ALL ON public.telecom_runner_heartbeats TO service_role;

-- RPC: register_telecom_runner_heartbeat_atomic
CREATE OR REPLACE FUNCTION public.register_telecom_runner_heartbeat_atomic(
  p_runner_id TEXT,
  p_organization_id UUID,
  p_authorization_id UUID,
  p_destination_fingerprint TEXT,
  p_status TEXT DEFAULT 'WAITING_FOR_CALL',
  p_ttl_seconds INT DEFAULT 10
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_hb_id UUID;
  v_expires_at TIMESTAMPTZ;
  v_norm_fp TEXT;
BEGIN
  v_norm_fp := trim(p_destination_fingerprint);
  v_expires_at := NOW() + (p_ttl_seconds || ' seconds')::INTERVAL;

  IF p_runner_id IS NULL OR length(trim(p_runner_id)) = 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'INVALID_RUNNER_ID');
  END IF;

  IF v_norm_fp IS NULL OR length(v_norm_fp) = 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'INVALID_DESTINATION_FINGERPRINT');
  END IF;

  -- Upsert runner heartbeat record
  INSERT INTO public.telecom_runner_heartbeats (
    runner_id,
    organization_id,
    authorization_id,
    destination_fingerprint,
    status,
    started_at,
    last_heartbeat_at,
    expires_at,
    updated_at
  ) VALUES (
    trim(p_runner_id),
    p_organization_id,
    p_authorization_id,
    v_norm_fp,
    p_status,
    NOW(),
    NOW(),
    v_expires_at,
    NOW()
  )
  RETURNING id INTO v_hb_id;

  RETURN jsonb_build_object(
    'success', true,
    'heartbeat_id', v_hb_id,
    'last_heartbeat_at', NOW(),
    'expires_at', v_expires_at
  );
END;
$$;
