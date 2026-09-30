-- supabase/migrations/20261218000000_phase13_4_3b2f4_rpc_security_remediation.sql
-- Phase 13.4.3B.2F.4 Server-Only RPC Security & EXECUTE Privilege Remediation
-- Fixes browser-callable vulnerability on SECURITY DEFINER heartbeat RPC register_telecom_runner_heartbeat_atomic
-- Revokes EXECUTE privileges from PUBLIC, authenticated, and anon roles.
-- Grants EXECUTE privileges exclusively to service_role.

BEGIN;

-- 1. Re-declare register_telecom_runner_heartbeat_atomic with strict search_path = public, pg_temp
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
SET search_path = public, pg_temp
AS $$
DECLARE
  v_hb_id UUID;
  v_expires_at TIMESTAMPTZ;
  v_norm_fp TEXT;
BEGIN
  v_norm_fp := pg_catalog.btrim(COALESCE(p_destination_fingerprint, ''));
  v_expires_at := pg_catalog.now() + (p_ttl_seconds || ' seconds')::INTERVAL;

  IF p_runner_id IS NULL OR length(pg_catalog.btrim(p_runner_id)) = 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'INVALID_RUNNER_ID');
  END IF;

  IF length(v_norm_fp) = 0 THEN
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
    pg_catalog.btrim(p_runner_id),
    p_organization_id,
    p_authorization_id,
    v_norm_fp,
    p_status,
    pg_catalog.now(),
    pg_catalog.now(),
    v_expires_at,
    pg_catalog.now()
  )
  RETURNING id INTO v_hb_id;

  RETURN jsonb_build_object(
    'success', true,
    'heartbeat_id', v_hb_id,
    'last_heartbeat_at', pg_catalog.now(),
    'expires_at', v_expires_at
  );
END;
$$;

-- 2. Revoke EXECUTE privileges from PUBLIC, authenticated, and anon roles
REVOKE EXECUTE ON FUNCTION public.register_telecom_runner_heartbeat_atomic(TEXT, UUID, UUID, TEXT, TEXT, INT) FROM PUBLIC, authenticated, anon;

-- 3. Grant EXECUTE privileges exclusively to service_role
GRANT EXECUTE ON FUNCTION public.register_telecom_runner_heartbeat_atomic(TEXT, UUID, UUID, TEXT, TEXT, INT) TO service_role;

COMMIT;
