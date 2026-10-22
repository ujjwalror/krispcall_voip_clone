-- ==============================================================================
-- PHASE 24B / 24B.1 MIGRATION: LOCAL PARENT-PROTECTION CONTROL PLANE AND INBOUND-SAFE CIRCUIT BREAKERS
-- HARDENED AUTHORITY SEPARATION (TENANT VOLUNTARY vs PLATFORM SECURITY ENFORCEMENT)
-- ==============================================================================
-- MODE: LOCAL FILE CREATION ONLY.
-- DO NOT APPLY TO PRODUCTION WITHOUT EXPLICIT OPERATOR AUTHORIZATION.
--
-- This migration establishes:
-- 1. public.organization_telecom_circuit_breakers
--    Independent, orthogonal capability switches for tenant-level local containment.
--    Monotonically separates:
--      - TENANT_VOLUNTARY_CONTROLS (tenant_outbound_voice_enabled, etc. - toggleable by tenant admin)
--      - PLATFORM_SECURITY_RESTRICTIONS (platform_outbound_voice_blocked, etc. - toggleable ONLY by platform admin)
--      - Effective booleans (outbound_voice_allowed, etc.) computed monotonically:
--        effective_allowed = (tenant_enabled AND NOT platform_blocked).
--
-- 2. public.platform_global_emergency_controls
--    Platform-scoped emergency stop switches for global service-level protection.
--    Writable ONLY by platform-security/admin authority.
--
-- 3. public.telecom_control_audit_events
--    Append-only, sanitized security audit trail for all control evaluations and state changes.
--
-- 4. Atomic RPC functions with server-side identity verification and strict RBAC.
-- ==============================================================================

-- 1. TENANT CIRCUIT BREAKERS TABLE
CREATE TABLE IF NOT EXISTS public.organization_telecom_circuit_breakers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,

    -- Tenant Voluntary Controls (Tenant admin may voluntarily restrict own workspace)
    tenant_outbound_voice_enabled BOOLEAN NOT NULL DEFAULT true,
    tenant_outbound_messaging_enabled BOOLEAN NOT NULL DEFAULT true,
    tenant_number_acquisition_enabled BOOLEAN NOT NULL DEFAULT true,
    tenant_number_release_enabled BOOLEAN NOT NULL DEFAULT true,
    tenant_porting_enabled BOOLEAN NOT NULL DEFAULT true,
    tenant_provisioning_enabled BOOLEAN NOT NULL DEFAULT true,
    tenant_forwarding_enabled BOOLEAN NOT NULL DEFAULT true,
    tenant_inbound_voice_enabled BOOLEAN NOT NULL DEFAULT true,
    tenant_inbound_messaging_enabled BOOLEAN NOT NULL DEFAULT true,
    tenant_restriction_reason TEXT NULL,
    tenant_restricted_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    tenant_restricted_at TIMESTAMPTZ NULL,

    -- Platform Security Restrictions (Platform admin only; tenant admin CANNOT remove)
    platform_outbound_voice_blocked BOOLEAN NOT NULL DEFAULT false,
    platform_outbound_messaging_blocked BOOLEAN NOT NULL DEFAULT false,
    platform_number_acquisition_blocked BOOLEAN NOT NULL DEFAULT false,
    platform_number_release_blocked BOOLEAN NOT NULL DEFAULT false,
    platform_porting_blocked BOOLEAN NOT NULL DEFAULT false,
    platform_provisioning_blocked BOOLEAN NOT NULL DEFAULT false,
    platform_forwarding_blocked BOOLEAN NOT NULL DEFAULT false,
    platform_inbound_voice_blocked BOOLEAN NOT NULL DEFAULT false,
    platform_inbound_messaging_blocked BOOLEAN NOT NULL DEFAULT false,
    platform_restriction_reason TEXT NULL,
    platform_restricted_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    platform_restricted_at TIMESTAMPTZ NULL,
    platform_restoration_reason TEXT NULL,
    platform_restored_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    platform_restored_at TIMESTAMPTZ NULL,

    -- Monotonic Effective Computed Capabilities (Generated Always Stored)
    outbound_voice_allowed BOOLEAN GENERATED ALWAYS AS (tenant_outbound_voice_enabled AND NOT platform_outbound_voice_blocked) STORED,
    outbound_messaging_allowed BOOLEAN GENERATED ALWAYS AS (tenant_outbound_messaging_enabled AND NOT platform_outbound_messaging_blocked) STORED,
    number_acquisition_allowed BOOLEAN GENERATED ALWAYS AS (tenant_number_acquisition_enabled AND NOT platform_number_acquisition_blocked) STORED,
    number_release_allowed BOOLEAN GENERATED ALWAYS AS (tenant_number_release_enabled AND NOT platform_number_release_blocked) STORED,
    porting_mutations_allowed BOOLEAN GENERATED ALWAYS AS (tenant_porting_enabled AND NOT platform_porting_blocked) STORED,
    provider_account_provisioning_allowed BOOLEAN GENERATED ALWAYS AS (tenant_provisioning_enabled AND NOT platform_provisioning_blocked) STORED,
    external_call_forwarding_allowed BOOLEAN GENERATED ALWAYS AS (tenant_forwarding_enabled AND NOT platform_forwarding_blocked) STORED,
    inbound_voice_allowed BOOLEAN GENERATED ALWAYS AS (tenant_inbound_voice_enabled AND NOT platform_inbound_voice_blocked) STORED,
    inbound_messaging_allowed BOOLEAN GENERATED ALWAYS AS (tenant_inbound_messaging_enabled AND NOT platform_inbound_messaging_blocked) STORED,

    containment_reason TEXT NULL,
    contained_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    contained_at TIMESTAMPTZ NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Index for tenant lookup
CREATE INDEX IF NOT EXISTS idx_org_circuit_breakers_org_id
ON public.organization_telecom_circuit_breakers(organization_id);

COMMENT ON TABLE public.organization_telecom_circuit_breakers IS
'Authoritative per-tenant circuit breaker flags with strict monotonic separation between tenant voluntary controls and immutable platform security restrictions.';

-- 2. GLOBAL EMERGENCY CONTROLS TABLE
CREATE TABLE IF NOT EXISTS public.platform_global_emergency_controls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    control_key TEXT NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT false, -- true = EMERGENCY STOP IS ACTIVE (BLOCKED)
    reason TEXT NULL,
    activated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    activated_at TIMESTAMPTZ NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

COMMENT ON TABLE public.platform_global_emergency_controls IS
'Platform-wide emergency stop controls for catastrophic event containment. Writable ONLY by platform security administrators.';

-- Seed default global emergency controls (all inactive / unblocked by default)
INSERT INTO public.platform_global_emergency_controls (control_key, is_active, reason)
VALUES
    ('NEW_OUTBOUND_VOICE', false, 'Normal operations'),
    ('NEW_OUTBOUND_MESSAGING', false, 'Normal operations'),
    ('NEW_NUMBER_ACQUISITION', false, 'Normal operations'),
    ('NEW_NUMBER_RELEASE', false, 'Normal operations'),
    ('NEW_PORTING_MUTATIONS', false, 'Normal operations'),
    ('NEW_PROVIDER_ACCOUNT_PROVISIONING', false, 'Normal operations'),
    ('EXTERNAL_PSTN_FORWARDING', false, 'Normal operations')
ON CONFLICT (control_key) DO NOTHING;

-- 3. SANITIZED AUDIT LOG TABLE
CREATE TABLE IF NOT EXISTS public.telecom_control_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE SET NULL,
    actor_id UUID NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
    authority TEXT NULL CHECK (authority IN ('PLATFORM_SECURITY', 'TENANT_ADMIN', 'GLOBAL_EMERGENCY', 'SYSTEM_DEFAULT')),
    control_type TEXT NOT NULL CHECK (control_type IN ('TENANT_CIRCUIT_BREAKER', 'PLATFORM_SECURITY', 'GLOBAL_EMERGENCY', 'ACTIVE_CALL_TERMINATION', 'CONTROL_OVERRIDE')),
    operation TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('ALLOWED', 'BLOCKED', 'RESTRICTED', 'OVERRIDDEN')),
    reason_code TEXT NOT NULL,
    reason TEXT NOT NULL,
    previous_state JSONB NULL,
    new_state JSONB NULL,
    correlation_id TEXT NULL,
    metadata JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS idx_telecom_control_audit_org_time
ON public.telecom_control_audit_events(organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telecom_control_audit_type_time
ON public.telecom_control_audit_events(control_type, created_at DESC);

COMMENT ON TABLE public.telecom_control_audit_events IS
'Append-only, sanitized audit log for all control-plane circuit breaker modifications and evaluations.';

-- 4. RLS POLICIES & SECURITY GRANTS
ALTER TABLE public.organization_telecom_circuit_breakers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_global_emergency_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telecom_control_audit_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.organization_telecom_circuit_breakers FROM PUBLIC, anon;
REVOKE ALL ON public.platform_global_emergency_controls FROM PUBLIC, anon;
REVOKE ALL ON public.telecom_control_audit_events FROM PUBLIC, anon;

GRANT ALL ON public.organization_telecom_circuit_breakers TO service_role;
GRANT ALL ON public.platform_global_emergency_controls TO service_role;
GRANT ALL ON public.telecom_control_audit_events TO service_role;

GRANT SELECT ON public.organization_telecom_circuit_breakers TO authenticated;
GRANT SELECT ON public.platform_global_emergency_controls TO authenticated;
GRANT SELECT ON public.telecom_control_audit_events TO authenticated;

-- RLS: Tenant circuit breakers readable by org members
CREATE POLICY "org_members_read_telecom_circuit_breakers"
ON public.organization_telecom_circuit_breakers FOR SELECT TO authenticated
USING (
    organization_id IN (
        SELECT organization_id FROM public.profiles WHERE id = auth.uid()
    )
);

-- RLS: Global emergency controls readable by all authenticated users
CREATE POLICY "authenticated_read_global_emergency_controls"
ON public.platform_global_emergency_controls FOR SELECT TO authenticated
USING (true);

-- RLS: Audit events readable by org members for their org
CREATE POLICY "org_members_read_telecom_control_audit"
ON public.telecom_control_audit_events FOR SELECT TO authenticated
USING (
    organization_id IS NULL OR
    organization_id IN (
        SELECT organization_id FROM public.profiles WHERE id = auth.uid()
    )
);

-- 5. ATOMIC RPC FOR TENANT VOLUNTARY CONTROLS
-- Allowed for tenant owner/admin for their OWN org, or platform admin.
-- STRICTLY PROHIBITED FROM MUTATING PLATFORM SECURITY RESTRICTIONS.
CREATE OR REPLACE FUNCTION public.set_tenant_voluntary_telecom_control(
    p_organization_id UUID,
    p_actor_id UUID,
    p_controls JSONB,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor_role TEXT;
    v_actor_org UUID;
    v_existing RECORD;
    v_prev_state JSONB;
    v_new_state JSONB;
    v_new_version INT;
    v_result RECORD;
BEGIN
    -- 1. Server-side authoritative actor verification
    SELECT role, organization_id INTO v_actor_role, v_actor_org
    FROM public.profiles
    WHERE id = p_actor_id;

    IF v_actor_role IS NULL THEN
        RAISE EXCEPTION 'ACTOR_NOT_FOUND: Actor % does not exist in profiles', p_actor_id;
    END IF;

    -- Actor must be platform admin OR owner/admin of target org
    IF v_actor_role NOT IN ('super_admin', 'platform_admin') THEN
        IF v_actor_org <> p_organization_id THEN
            RAISE EXCEPTION 'TENANT_CONTROL_UNAUTHORIZED: Cross-organization modification forbidden';
        END IF;
        IF v_actor_role NOT IN ('owner', 'admin') THEN
            RAISE EXCEPTION 'TENANT_CONTROL_UNAUTHORIZED: Only organization owners/admins can modify voluntary controls';
        END IF;
    END IF;

    -- 2. Fetch or initialize existing record with row-level lock
    SELECT * INTO v_existing
    FROM public.organization_telecom_circuit_breakers
    WHERE organization_id = p_organization_id
    FOR UPDATE;

    IF v_existing.id IS NULL THEN
        INSERT INTO public.organization_telecom_circuit_breakers (
            organization_id,
            version
        ) VALUES (
            p_organization_id,
            1
        )
        RETURNING * INTO v_existing;
    END IF;

    v_prev_state := to_jsonb(v_existing);
    v_new_version := v_existing.version + 1;

    -- 3. Apply ONLY voluntary updates (platform security columns untouched)
    UPDATE public.organization_telecom_circuit_breakers
    SET
        tenant_outbound_voice_enabled = COALESCE((p_controls->>'tenant_outbound_voice_enabled')::BOOLEAN, tenant_outbound_voice_enabled),
        tenant_outbound_messaging_enabled = COALESCE((p_controls->>'tenant_outbound_messaging_enabled')::BOOLEAN, tenant_outbound_messaging_enabled),
        tenant_number_acquisition_enabled = COALESCE((p_controls->>'tenant_number_acquisition_enabled')::BOOLEAN, tenant_number_acquisition_enabled),
        tenant_number_release_enabled = COALESCE((p_controls->>'tenant_number_release_enabled')::BOOLEAN, tenant_number_release_enabled),
        tenant_porting_enabled = COALESCE((p_controls->>'tenant_porting_enabled')::BOOLEAN, tenant_porting_enabled),
        tenant_provisioning_enabled = COALESCE((p_controls->>'tenant_provisioning_enabled')::BOOLEAN, tenant_provisioning_enabled),
        tenant_forwarding_enabled = COALESCE((p_controls->>'tenant_forwarding_enabled')::BOOLEAN, tenant_forwarding_enabled),
        tenant_inbound_voice_enabled = COALESCE((p_controls->>'tenant_inbound_voice_enabled')::BOOLEAN, tenant_inbound_voice_enabled),
        tenant_inbound_messaging_enabled = COALESCE((p_controls->>'tenant_inbound_messaging_enabled')::BOOLEAN, tenant_inbound_messaging_enabled),
        tenant_restriction_reason = COALESCE(p_reason, tenant_restriction_reason),
        tenant_restricted_by = p_actor_id,
        tenant_restricted_at = pg_catalog.now(),
        version = v_new_version,
        updated_at = pg_catalog.now()
    WHERE organization_id = p_organization_id
    RETURNING * INTO v_result;

    v_new_state := to_jsonb(v_result);

    -- 4. Insert audit log
    INSERT INTO public.telecom_control_audit_events (
        organization_id,
        actor_id,
        authority,
        control_type,
        operation,
        decision,
        reason_code,
        reason,
        previous_state,
        new_state
    ) VALUES (
        p_organization_id,
        p_actor_id,
        CASE WHEN v_actor_role IN ('super_admin', 'platform_admin') THEN 'PLATFORM_SECURITY' ELSE 'TENANT_ADMIN' END,
        'TENANT_CIRCUIT_BREAKER',
        'UPDATE_TENANT_VOLUNTARY_CONTROLS',
        'ALLOWED',
        'TENANT_VOLUNTARY_UPDATED',
        COALESCE(p_reason, 'Tenant voluntary controls updated'),
        v_prev_state,
        v_new_state
    );

    RETURN v_new_state;
END;
$$;

-- 6. ATOMIC RPC FOR PLATFORM SECURITY RESTRICTIONS
-- STRICTLY RESTRICTED TO PLATFORM SECURITY ADMINISTRATORS.
-- Requires non-empty reason for blocks, and restoration_reason for unblocks.
CREATE OR REPLACE FUNCTION public.set_platform_security_telecom_restriction(
    p_organization_id UUID,
    p_actor_id UUID,
    p_restrictions JSONB,
    p_reason TEXT DEFAULT NULL,
    p_restoration_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor_role TEXT;
    v_existing RECORD;
    v_prev_state JSONB;
    v_new_state JSONB;
    v_new_version INT;
    v_result RECORD;
    v_is_imposing BOOLEAN := false;
    v_is_restoring BOOLEAN := false;
BEGIN
    -- 1. Server-side authoritative actor verification
    SELECT role INTO v_actor_role
    FROM public.profiles
    WHERE id = p_actor_id;

    IF v_actor_role IS NULL OR v_actor_role NOT IN ('super_admin', 'platform_admin') THEN
        RAISE EXCEPTION 'PLATFORM_SECURITY_CONTROL_UNAUTHORIZED: Only platform security administrators can modify platform security restrictions';
    END IF;

    -- Check if imposing or restoring
    IF (p_restrictions->>'platform_outbound_voice_blocked')::BOOLEAN = true OR
       (p_restrictions->>'platform_outbound_messaging_blocked')::BOOLEAN = true OR
       (p_restrictions->>'platform_number_acquisition_blocked')::BOOLEAN = true OR
       (p_restrictions->>'platform_number_release_blocked')::BOOLEAN = true OR
       (p_restrictions->>'platform_porting_blocked')::BOOLEAN = true OR
       (p_restrictions->>'platform_provisioning_blocked')::BOOLEAN = true OR
       (p_restrictions->>'platform_forwarding_blocked')::BOOLEAN = true OR
       (p_restrictions->>'platform_inbound_voice_blocked')::BOOLEAN = true OR
       (p_restrictions->>'platform_inbound_messaging_blocked')::BOOLEAN = true THEN
        v_is_imposing := true;
    END IF;

    IF (p_restrictions->>'platform_outbound_voice_blocked')::BOOLEAN = false OR
       (p_restrictions->>'platform_outbound_messaging_blocked')::BOOLEAN = false OR
       (p_restrictions->>'platform_number_acquisition_blocked')::BOOLEAN = false OR
       (p_restrictions->>'platform_number_release_blocked')::BOOLEAN = false OR
       (p_restrictions->>'platform_porting_blocked')::BOOLEAN = false OR
       (p_restrictions->>'platform_provisioning_blocked')::BOOLEAN = false OR
       (p_restrictions->>'platform_forwarding_blocked')::BOOLEAN = false OR
       (p_restrictions->>'platform_inbound_voice_blocked')::BOOLEAN = false OR
       (p_restrictions->>'platform_inbound_messaging_blocked')::BOOLEAN = false THEN
        v_is_restoring := true;
    END IF;

    -- Mandatory audit reasons
    IF v_is_imposing AND (p_reason IS NULL OR trim(p_reason) = '') THEN
        RAISE EXCEPTION 'PLATFORM_RESTRICTION_REASON_REQUIRED: A non-empty reason is required to impose platform security restrictions';
    END IF;

    IF v_is_restoring AND (p_restoration_reason IS NULL OR trim(p_restoration_reason) = '') THEN
        RAISE EXCEPTION 'PLATFORM_RESTORATION_REASON_REQUIRED: A non-empty restoration reason is required to remove platform security restrictions';
    END IF;

    -- 2. Fetch or initialize existing record with lock
    SELECT * INTO v_existing
    FROM public.organization_telecom_circuit_breakers
    WHERE organization_id = p_organization_id
    FOR UPDATE;

    IF v_existing.id IS NULL THEN
        INSERT INTO public.organization_telecom_circuit_breakers (
            organization_id,
            version
        ) VALUES (
            p_organization_id,
            1
        )
        RETURNING * INTO v_existing;
    END IF;

    v_prev_state := to_jsonb(v_existing);
    v_new_version := v_existing.version + 1;

    -- 3. Apply platform security updates
    UPDATE public.organization_telecom_circuit_breakers
    SET
        platform_outbound_voice_blocked = COALESCE((p_restrictions->>'platform_outbound_voice_blocked')::BOOLEAN, platform_outbound_voice_blocked),
        platform_outbound_messaging_blocked = COALESCE((p_restrictions->>'platform_outbound_messaging_blocked')::BOOLEAN, platform_outbound_messaging_blocked),
        platform_number_acquisition_blocked = COALESCE((p_restrictions->>'platform_number_acquisition_blocked')::BOOLEAN, platform_number_acquisition_blocked),
        platform_number_release_blocked = COALESCE((p_restrictions->>'platform_number_release_blocked')::BOOLEAN, platform_number_release_blocked),
        platform_porting_blocked = COALESCE((p_restrictions->>'platform_porting_blocked')::BOOLEAN, platform_porting_blocked),
        platform_provisioning_blocked = COALESCE((p_restrictions->>'platform_provisioning_blocked')::BOOLEAN, platform_provisioning_blocked),
        platform_forwarding_blocked = COALESCE((p_restrictions->>'platform_forwarding_blocked')::BOOLEAN, platform_forwarding_blocked),
        platform_inbound_voice_blocked = COALESCE((p_restrictions->>'platform_inbound_voice_blocked')::BOOLEAN, platform_inbound_voice_blocked),
        platform_inbound_messaging_blocked = COALESCE((p_restrictions->>'platform_inbound_messaging_blocked')::BOOLEAN, platform_inbound_messaging_blocked),
        platform_restriction_reason = CASE WHEN v_is_imposing THEN p_reason ELSE platform_restriction_reason END,
        platform_restricted_by = CASE WHEN v_is_imposing THEN p_actor_id ELSE platform_restricted_by END,
        platform_restricted_at = CASE WHEN v_is_imposing THEN pg_catalog.now() ELSE platform_restricted_at END,
        platform_restoration_reason = CASE WHEN v_is_restoring THEN p_restoration_reason ELSE platform_restoration_reason END,
        platform_restored_by = CASE WHEN v_is_restoring THEN p_actor_id ELSE platform_restored_by END,
        platform_restored_at = CASE WHEN v_is_restoring THEN pg_catalog.now() ELSE platform_restored_at END,
        version = v_new_version,
        updated_at = pg_catalog.now()
    WHERE organization_id = p_organization_id
    RETURNING * INTO v_result;

    v_new_state := to_jsonb(v_result);

    -- 4. Insert audit log
    INSERT INTO public.telecom_control_audit_events (
        organization_id,
        actor_id,
        authority,
        control_type,
        operation,
        decision,
        reason_code,
        reason,
        previous_state,
        new_state
    ) VALUES (
        p_organization_id,
        p_actor_id,
        'PLATFORM_SECURITY',
        'PLATFORM_SECURITY',
        'UPDATE_PLATFORM_SECURITY_RESTRICTIONS',
        CASE WHEN v_is_imposing THEN 'BLOCKED' ELSE 'ALLOWED' END,
        CASE WHEN v_is_imposing THEN 'PLATFORM_RESTRICTION_IMPOSED' ELSE 'PLATFORM_RESTRICTION_REMOVED' END,
        COALESCE(CASE WHEN v_is_imposing THEN p_reason ELSE p_restoration_reason END, 'Platform security restriction modified'),
        v_prev_state,
        v_new_state
    );

    RETURN v_new_state;
END;
$$;

-- 7. BACKWARD-COMPATIBLE RPC FOR TENANT CIRCUIT BREAKER TOGGLE
-- Automatically dispatches to voluntary controls if called by tenant admin,
-- preventing tenant admins from modifying platform security restrictions.
CREATE OR REPLACE FUNCTION public.set_organization_telecom_circuit_breaker(
    p_organization_id UUID,
    p_actor_id UUID,
    p_updates JSONB,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor_role TEXT;
    v_actor_org UUID;
    v_voluntary_controls JSONB := '{}'::JSONB;
BEGIN
    SELECT role, organization_id INTO v_actor_role, v_actor_org
    FROM public.profiles
    WHERE id = p_actor_id;

    IF v_actor_role IS NULL THEN
        RAISE EXCEPTION 'ACTOR_NOT_FOUND: Actor % does not exist', p_actor_id;
    END IF;

    -- If actor is tenant admin, map updates directly to voluntary controls
    IF v_actor_role NOT IN ('super_admin', 'platform_admin') THEN
        IF v_actor_org <> p_organization_id OR v_actor_role NOT IN ('owner', 'admin') THEN
            RAISE EXCEPTION 'TENANT_CONTROL_UNAUTHORIZED: Insufficient permissions to modify circuit breakers';
        END IF;

        IF p_updates ? 'outbound_voice_allowed' THEN
            v_voluntary_controls := jsonb_set(v_voluntary_controls, '{tenant_outbound_voice_enabled}', p_updates->'outbound_voice_allowed');
        END IF;
        IF p_updates ? 'outbound_messaging_allowed' THEN
            v_voluntary_controls := jsonb_set(v_voluntary_controls, '{tenant_outbound_messaging_enabled}', p_updates->'outbound_messaging_allowed');
        END IF;
        IF p_updates ? 'number_acquisition_allowed' THEN
            v_voluntary_controls := jsonb_set(v_voluntary_controls, '{tenant_number_acquisition_enabled}', p_updates->'number_acquisition_allowed');
        END IF;
        IF p_updates ? 'number_release_allowed' THEN
            v_voluntary_controls := jsonb_set(v_voluntary_controls, '{tenant_number_release_enabled}', p_updates->'number_release_allowed');
        END IF;
        IF p_updates ? 'porting_mutations_allowed' THEN
            v_voluntary_controls := jsonb_set(v_voluntary_controls, '{tenant_porting_enabled}', p_updates->'porting_mutations_allowed');
        END IF;
        IF p_updates ? 'provider_account_provisioning_allowed' THEN
            v_voluntary_controls := jsonb_set(v_voluntary_controls, '{tenant_provisioning_enabled}', p_updates->'provider_account_provisioning_allowed');
        END IF;
        IF p_updates ? 'external_call_forwarding_allowed' THEN
            v_voluntary_controls := jsonb_set(v_voluntary_controls, '{tenant_forwarding_enabled}', p_updates->'external_call_forwarding_allowed');
        END IF;
        IF p_updates ? 'inbound_voice_allowed' THEN
            v_voluntary_controls := jsonb_set(v_voluntary_controls, '{tenant_inbound_voice_enabled}', p_updates->'inbound_voice_allowed');
        END IF;
        IF p_updates ? 'inbound_messaging_allowed' THEN
            v_voluntary_controls := jsonb_set(v_voluntary_controls, '{tenant_inbound_messaging_enabled}', p_updates->'inbound_messaging_allowed');
        END IF;

        RETURN public.set_tenant_voluntary_telecom_control(
            p_organization_id,
            p_actor_id,
            v_voluntary_controls,
            p_reason
        );
    END IF;

    -- Platform admin may update voluntary controls via this wrapper
    IF p_updates ? 'outbound_voice_allowed' THEN
        v_voluntary_controls := jsonb_set(v_voluntary_controls, '{tenant_outbound_voice_enabled}', p_updates->'outbound_voice_allowed');
    END IF;
    IF p_updates ? 'outbound_messaging_allowed' THEN
        v_voluntary_controls := jsonb_set(v_voluntary_controls, '{tenant_outbound_messaging_enabled}', p_updates->'outbound_messaging_allowed');
    END IF;
    IF p_updates ? 'number_acquisition_allowed' THEN
        v_voluntary_controls := jsonb_set(v_voluntary_controls, '{tenant_number_acquisition_enabled}', p_updates->'number_acquisition_allowed');
    END IF;
    IF p_updates ? 'number_release_allowed' THEN
        v_voluntary_controls := jsonb_set(v_voluntary_controls, '{tenant_number_release_enabled}', p_updates->'number_release_allowed');
    END IF;
    IF p_updates ? 'porting_mutations_allowed' THEN
        v_voluntary_controls := jsonb_set(v_voluntary_controls, '{tenant_porting_enabled}', p_updates->'porting_mutations_allowed');
    END IF;
    IF p_updates ? 'provider_account_provisioning_allowed' THEN
        v_voluntary_controls := jsonb_set(v_voluntary_controls, '{tenant_provisioning_enabled}', p_updates->'provider_account_provisioning_allowed');
    END IF;
    IF p_updates ? 'external_call_forwarding_allowed' THEN
        v_voluntary_controls := jsonb_set(v_voluntary_controls, '{tenant_forwarding_enabled}', p_updates->'external_call_forwarding_allowed');
    END IF;
    IF p_updates ? 'inbound_voice_allowed' THEN
        v_voluntary_controls := jsonb_set(v_voluntary_controls, '{tenant_inbound_voice_enabled}', p_updates->'inbound_voice_allowed');
    END IF;
    IF p_updates ? 'inbound_messaging_allowed' THEN
        v_voluntary_controls := jsonb_set(v_voluntary_controls, '{tenant_inbound_messaging_enabled}', p_updates->'inbound_messaging_allowed');
    END IF;

    RETURN public.set_tenant_voluntary_telecom_control(
        p_organization_id,
        p_actor_id,
        v_voluntary_controls,
        p_reason
    );
END;
$$;

-- 8. ATOMIC RPC FOR GLOBAL EMERGENCY STOP TOGGLE
CREATE OR REPLACE FUNCTION public.set_platform_global_emergency_control(
    p_control_key TEXT,
    p_is_active BOOLEAN,
    p_actor_id UUID,
    p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor_role TEXT;
    v_existing RECORD;
    v_prev_state JSONB;
    v_new_state JSONB;
    v_new_version INT;
    v_result RECORD;
BEGIN
    -- 1. Strictly verify platform admin permission
    SELECT role INTO v_actor_role
    FROM public.profiles
    WHERE id = p_actor_id;

    IF v_actor_role IS NULL OR v_actor_role NOT IN ('super_admin', 'platform_admin') THEN
        RAISE EXCEPTION 'GLOBAL_EMERGENCY_CONTROL_UNAUTHORIZED: Only platform security administrators can toggle global emergency controls';
    END IF;

    IF p_reason IS NULL OR trim(p_reason) = '' THEN
        RAISE EXCEPTION 'REASON_REQUIRED: A non-empty reason is required to toggle global emergency controls';
    END IF;

    -- 2. Fetch existing control with lock
    SELECT * INTO v_existing
    FROM public.platform_global_emergency_controls
    WHERE control_key = p_control_key
    FOR UPDATE;

    IF v_existing.id IS NULL THEN
        RAISE EXCEPTION 'INVALID_CONTROL_KEY: Global emergency control % does not exist', p_control_key;
    END IF;

    v_prev_state := to_jsonb(v_existing);
    v_new_version := v_existing.version + 1;

    -- 3. Apply update
    UPDATE public.platform_global_emergency_controls
    SET
        is_active = p_is_active,
        reason = p_reason,
        activated_by = p_actor_id,
        activated_at = CASE WHEN p_is_active THEN pg_catalog.now() ELSE activated_at END,
        version = v_new_version,
        updated_at = pg_catalog.now()
    WHERE control_key = p_control_key
    RETURNING * INTO v_result;

    v_new_state := to_jsonb(v_result);

    -- 4. Record audit event
    INSERT INTO public.telecom_control_audit_events (
        organization_id,
        actor_id,
        authority,
        control_type,
        operation,
        decision,
        reason_code,
        reason,
        previous_state,
        new_state
    ) VALUES (
        NULL,
        p_actor_id,
        'GLOBAL_EMERGENCY',
        'GLOBAL_EMERGENCY',
        p_control_key,
        CASE WHEN p_is_active THEN 'BLOCKED' ELSE 'ALLOWED' END,
        CASE WHEN p_is_active THEN 'EMERGENCY_STOP_ACTIVATED' ELSE 'EMERGENCY_STOP_DEACTIVATED' END,
        p_reason,
        v_prev_state,
        v_new_state
    );

    RETURN v_new_state;
END;
$$;
