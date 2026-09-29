-- ============================================================================
-- PUBLIC SAAS PHASE 13.4.3B.2C — ATOMIC MESSAGE PROVIDER RESOURCE LINKAGE RPC
-- Date: 2026-12-12
-- Creates public.link_telecom_message_provider_resource_atomic function to guarantee
-- atomic write-once provider MessageSid identity establishment and non-contradiction
-- validation under concurrent callbacks for SMS/MMS messaging.
-- Server-only (service_role only) SECURITY DEFINER RPC with explicit FOR UPDATE locking.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.link_telecom_message_provider_resource_atomic(
  p_organization_id UUID,
  p_session_id TEXT,
  p_component_id TEXT,
  p_provider_message_sid TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_clean_org_id UUID;
  v_clean_session_id TEXT;
  v_clean_component_id TEXT;
  v_clean_sid TEXT;
  v_comp public.telecom_usage_components;
BEGIN
  v_clean_org_id := p_organization_id;
  v_clean_session_id := pg_catalog.btrim(COALESCE(p_session_id, ''));
  v_clean_component_id := pg_catalog.btrim(COALESCE(p_component_id, ''));
  v_clean_sid := pg_catalog.btrim(COALESCE(p_provider_message_sid, ''));

  -- 1. Input Validation
  IF v_clean_org_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_organization_id is required.';
  END IF;
  IF length(v_clean_session_id) = 0 THEN
    RAISE EXCEPTION 'INVALID_SESSION_ID: p_session_id is required.';
  END IF;
  IF length(v_clean_component_id) = 0 THEN
    RAISE EXCEPTION 'INVALID_COMPONENT_ID: p_component_id is required.';
  END IF;
  IF length(v_clean_sid) = 0 THEN
    RAISE EXCEPTION 'INVALID_PROVIDER_MESSAGE_SID: p_provider_message_sid is required.';
  END IF;

  -- 2. Lock Organization Row for Serialization Boundary
  PERFORM id FROM public.organizations WHERE id = v_clean_org_id FOR UPDATE;

  -- 3. Lock Component Row FOR UPDATE
  SELECT * INTO v_comp
  FROM public.telecom_usage_components
  WHERE organization_id = v_clean_org_id AND component_id = v_clean_component_id
  FOR UPDATE;

  -- 4. Verify Component Existence & Session Isolation
  IF v_comp.component_id IS NULL THEN
    RAISE EXCEPTION 'COMPONENT_NOT_FOUND: Component % not found for organization %', v_clean_component_id, v_clean_org_id;
  END IF;

  IF v_comp.session_id <> v_clean_session_id THEN
    RAISE EXCEPTION 'SESSION_MISMATCH: Component % belongs to session %, not %', v_clean_component_id, v_comp.session_id, v_clean_session_id;
  END IF;

  -- 5. Atomic Write-Once Provider Identity Linkage
  IF v_comp.child_provider_resource_id IS NULL THEN
    UPDATE public.telecom_usage_components
    SET child_provider_resource_id = v_clean_sid,
        updated_at = pg_catalog.now()
    WHERE organization_id = v_clean_org_id AND component_id = v_clean_component_id;

    RETURN jsonb_build_object(
      'success', true,
      'status', 'linked',
      'provider_message_sid', v_clean_sid
    );
  ELSIF v_comp.child_provider_resource_id = v_clean_sid THEN
    RETURN jsonb_build_object(
      'success', true,
      'status', 'idempotent_match',
      'provider_message_sid', v_clean_sid
    );
  ELSE
    RAISE EXCEPTION 'MESSAGE_SID_MISMATCH: Stored provider MessageSid % conflicts with incoming MessageSid %', v_comp.child_provider_resource_id, v_clean_sid;
  END IF;
END;
$$;

-- Server-only privileges
REVOKE ALL ON FUNCTION public.link_telecom_message_provider_resource_atomic(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_telecom_message_provider_resource_atomic(UUID, TEXT, TEXT, TEXT) TO service_role;

COMMIT;
