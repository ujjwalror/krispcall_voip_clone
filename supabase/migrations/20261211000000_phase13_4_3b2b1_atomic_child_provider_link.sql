-- ============================================================================
-- PUBLIC SAAS PHASE 13.4.3B.2B.1 — ATOMIC CHILD PROVIDER RESOURCE LINKAGE RPC
-- Date: 2026-12-11
-- Creates public.link_telecom_child_provider_resource_atomic function to guarantee
-- atomic write-once child provider CallSid identity establishment and non-contradiction
-- validation under concurrent callbacks.
-- Server-only (service_role only) SECURITY DEFINER RPC with explicit FOR UPDATE locking.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.link_telecom_child_provider_resource_atomic(
  p_organization_id UUID,
  p_session_id TEXT,
  p_component_id TEXT,
  p_child_provider_resource_id TEXT,
  p_parent_provider_resource_id TEXT DEFAULT NULL
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
  v_clean_child_sid TEXT;
  v_clean_parent_sid TEXT;
  v_comp public.telecom_usage_components;
BEGIN
  v_clean_org_id := p_organization_id;
  v_clean_session_id := pg_catalog.btrim(COALESCE(p_session_id, ''));
  v_clean_component_id := pg_catalog.btrim(COALESCE(p_component_id, ''));
  v_clean_child_sid := pg_catalog.btrim(COALESCE(p_child_provider_resource_id, ''));
  v_clean_parent_sid := pg_catalog.btrim(COALESCE(p_parent_provider_resource_id, ''));

  IF v_clean_parent_sid = '' THEN
    v_clean_parent_sid := NULL;
  END IF;

  -- 1. Input Validation Hardening
  IF v_clean_org_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_organization_id is required.';
  END IF;
  IF length(v_clean_session_id) = 0 THEN
    RAISE EXCEPTION 'INVALID_SESSION_ID: p_session_id is required.';
  END IF;
  IF length(v_clean_component_id) = 0 THEN
    RAISE EXCEPTION 'INVALID_COMPONENT_ID: p_component_id is required.';
  END IF;
  IF length(v_clean_child_sid) = 0 THEN
    RAISE EXCEPTION 'INVALID_CHILD_PROVIDER_RESOURCE_ID: p_child_provider_resource_id is required.';
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

  -- 5. Inspect Parent CallSid Identity Non-Contradiction
  IF v_comp.parent_provider_resource_id IS NOT NULL AND v_clean_parent_sid IS NOT NULL
     AND v_comp.parent_provider_resource_id <> v_clean_parent_sid THEN
    RAISE EXCEPTION 'PARENT_CALLSID_MISMATCH: Stored parent % conflicts with incoming parent %', v_comp.parent_provider_resource_id, v_clean_parent_sid;
  END IF;

  -- 6. Atomic Write-Once Child Identity Linkage
  IF v_comp.child_provider_resource_id IS NULL THEN
    UPDATE public.telecom_usage_components
    SET child_provider_resource_id = v_clean_child_sid,
        parent_provider_resource_id = COALESCE(v_clean_parent_sid, parent_provider_resource_id),
        updated_at = pg_catalog.now()
    WHERE organization_id = v_clean_org_id AND component_id = v_clean_component_id;

    RETURN jsonb_build_object(
      'success', true,
      'status', 'linked',
      'child_provider_resource_id', v_clean_child_sid,
      'parent_provider_resource_id', COALESCE(v_clean_parent_sid, v_comp.parent_provider_resource_id)
    );
  ELSIF v_comp.child_provider_resource_id = v_clean_child_sid THEN
    RETURN jsonb_build_object(
      'success', true,
      'status', 'idempotent_match',
      'child_provider_resource_id', v_clean_child_sid,
      'parent_provider_resource_id', v_comp.parent_provider_resource_id
    );
  ELSE
    RAISE EXCEPTION 'CHILD_CALLSID_MISMATCH: Stored child % conflicts with incoming child %', v_comp.child_provider_resource_id, v_clean_child_sid;
  END IF;
END;
$$;

-- Server-only privileges
REVOKE ALL ON FUNCTION public.link_telecom_child_provider_resource_atomic(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_telecom_child_provider_resource_atomic(UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;

COMMIT;
