-- ============================================================================
-- PUBLIC SAAS PHASE 13.4.3C SUBPHASE C.4E.RECON.C — RECONCILIATION LEASE & REPLAY HARDENING
-- Date: 2026-12-23
-- Extends public.billing_reconciliation_runs with cryptographic lease tokens, expiry timestamps,
-- and worker heartbeats for durable execution ownership and fencing.
-- Creates public.billing_reconciliation_hmac_nonces for distributed, atomic HMAC replay protection.
-- Implements atomic RPC functions for scope-serialized run claiming, lease renewal, and nonce verification.
-- SECURITY DEFINER functions set explicit search_path = public, pg_temp.
-- Access strictly revoked from PUBLIC, anon, authenticated; granted to service_role ONLY.
-- LOCAL MIGRATION ONLY — SUBJECT TO MANUAL DBA REVIEW. DO NOT EXECUTE REMOTELY AUTOMATICALLY.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Extend public.billing_reconciliation_runs with durable lease columns
-- ----------------------------------------------------------------------------
ALTER TABLE public.billing_reconciliation_runs
ADD COLUMN IF NOT EXISTS lease_token UUID NULL,
ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS worker_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_recon_runs_active_lease 
ON public.billing_reconciliation_runs (status, lease_expires_at) 
WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_billing_recon_runs_scope_lease 
ON public.billing_reconciliation_runs (run_type, organization_id, provider_account_id, status);

-- ----------------------------------------------------------------------------
-- 2. Create public.billing_reconciliation_hmac_nonces table for replay protection
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_reconciliation_hmac_nonces (
    nonce_hash TEXT PRIMARY KEY CHECK (pg_catalog.length(pg_catalog.btrim(nonce_hash)) = 64 AND nonce_hash ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_billing_recon_hmac_nonces_expires 
ON public.billing_reconciliation_hmac_nonces (expires_at);

ALTER TABLE public.billing_reconciliation_hmac_nonces ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.billing_reconciliation_hmac_nonces FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.billing_reconciliation_hmac_nonces TO service_role;

CREATE POLICY service_role_access_billing_reconciliation_hmac_nonces
ON public.billing_reconciliation_hmac_nonces
FOR ALL TO service_role
USING (true)
WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- 3. Atomic RPC: Claim Reconciliation Run with Empty-Set Race Protection
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_reconciliation_run_atomic(
    p_run_type TEXT,
    p_organization_id UUID DEFAULT NULL,
    p_provider_account_id UUID DEFAULT NULL,
    p_targeted_entity_type TEXT DEFAULT NULL,
    p_targeted_entity_id TEXT DEFAULT NULL,
    p_worker_id TEXT DEFAULT 'worker_default',
    p_lease_ttl_seconds INT DEFAULT 120,
    p_scope_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_clean_run_type TEXT;
    v_clean_worker_id TEXT;
    v_canonical_scope_key TEXT;
    v_lock_id BIGINT;
    v_active_run_id UUID := NULL;
    v_stale_run_id UUID := NULL;
    v_new_run_id UUID := NULL;
    v_lease_token UUID := NULL;
    v_now TIMESTAMPTZ := pg_catalog.now();
    v_lease_expires_at TIMESTAMPTZ;
    v_ttl INT;
BEGIN
    v_clean_run_type := pg_catalog.btrim(COALESCE(p_run_type, ''));
    v_clean_worker_id := pg_catalog.btrim(COALESCE(p_worker_id, 'worker_default'));
    v_ttl := GREATEST(15, COALESCE(p_lease_ttl_seconds, 120));

    -- Validate run_type
    IF v_clean_run_type NOT IN ('full_system', 'organization', 'provider_account', 'targeted') THEN
        RAISE EXCEPTION 'INVALID_SCOPE: p_run_type must be full_system, organization, provider_account, or targeted.';
    END IF;

    IF v_clean_run_type = 'organization' AND p_organization_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_SCOPE: p_organization_id is required for organization scope.';
    END IF;

    IF v_clean_run_type = 'provider_account' AND p_provider_account_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_SCOPE: p_provider_account_id is required for provider_account scope.';
    END IF;

    IF v_clean_run_type = 'targeted' AND (p_targeted_entity_type IS NULL OR p_targeted_entity_id IS NULL) THEN
        RAISE EXCEPTION 'INVALID_SCOPE: p_targeted_entity_type and p_targeted_entity_id are required for targeted scope.';
    END IF;

    -- Build deterministic canonical scope key for short claim transaction serialization
    v_canonical_scope_key := pg_catalog.lower(
        v_clean_run_type || ':' ||
        COALESCE(p_organization_id::text, 'none') || ':' ||
        COALESCE(p_provider_account_id::text, 'none') || ':' ||
        COALESCE(p_targeted_entity_type, 'none') || ':' ||
        COALESCE(p_targeted_entity_id, 'none')
    );

    -- Serialize claim RPC call via short transaction advisory lock (prevents empty-set claim race)
    v_lock_id := hashtext('recon_claim_scope:' || v_canonical_scope_key);
    PERFORM pg_advisory_xact_lock(v_lock_id);

    -- Check for existing active run for exact scope
    SELECT id INTO v_active_run_id
    FROM public.billing_reconciliation_runs
    WHERE run_type = v_clean_run_type
      AND (organization_id IS NOT DISTINCT FROM p_organization_id)
      AND (provider_account_id IS NOT DISTINCT FROM p_provider_account_id)
      AND status = 'running'
      AND lease_expires_at > v_now
    ORDER BY started_at DESC
    LIMIT 1;

    IF v_active_run_id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'claimed', false,
            'reason', 'ACTIVE_LEASE_EXISTS',
            'active_run_id', v_active_run_id
        );
    END IF;

    -- Check for expired stale running runs for exact scope and mark failed
    FOR v_stale_run_id IN
        SELECT id
        FROM public.billing_reconciliation_runs
        WHERE run_type = v_clean_run_type
          AND (organization_id IS NOT DISTINCT FROM p_organization_id)
          AND (provider_account_id IS NOT DISTINCT FROM p_provider_account_id)
          AND status = 'running'
          AND (lease_expires_at IS NULL OR lease_expires_at <= v_now)
        FOR UPDATE
    LOOP
        UPDATE public.billing_reconciliation_runs
        SET status = 'failed',
            completed_at = v_now,
            error_info = jsonb_build_object(
                'reason', 'LEASE_EXPIRED_WORKER_DIED',
                'superseded_at', v_now
            ),
            module_coverage = jsonb_set(
                COALESCE(module_coverage, '{}'::jsonb),
                '{eligibleForResolution}',
                'false'::jsonb
            )
        WHERE id = v_stale_run_id;
    END LOOP;

    -- Generate cryptographic UUID fencing token & expiration timestamp
    v_lease_token := gen_random_uuid();
    v_lease_expires_at := v_now + (v_ttl || ' seconds')::interval;

    -- Insert new run record
    INSERT INTO public.billing_reconciliation_runs (
        run_type,
        organization_id,
        provider_account_id,
        status,
        started_at,
        module_coverage,
        summary_counts,
        error_info,
        scope_metadata,
        lease_token,
        lease_expires_at,
        last_heartbeat_at,
        worker_id
    ) VALUES (
        v_clean_run_type,
        p_organization_id,
        p_provider_account_id,
        'running',
        v_now,
        jsonb_build_object(
            'eligibleForResolution', true,
            'modules', jsonb_build_object()
        ),
        jsonb_build_object('totalInspected', 0, 'findingsOpen', 0, 'findingsResolved', 0),
        '{}'::jsonb,
        jsonb_build_object(
            'runType', v_clean_run_type,
            'organizationId', p_organization_id,
            'providerAccountId', p_provider_account_id,
            'targetedEntityType', p_targeted_entity_type,
            'targetedEntityId', p_targeted_entity_id,
            'canonicalScopeKey', v_canonical_scope_key,
            'customMetadata', p_scope_metadata
        ),
        v_lease_token,
        v_lease_expires_at,
        v_now,
        v_clean_worker_id
    ) RETURNING id INTO v_new_run_id;

    RETURN jsonb_build_object(
        'claimed', true,
        'run_id', v_new_run_id,
        'lease_token', v_lease_token,
        'lease_expires_at', v_lease_expires_at,
        'canonical_scope_key', v_canonical_scope_key
    );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_reconciliation_run_atomic(TEXT, UUID, UUID, TEXT, TEXT, TEXT, INT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_reconciliation_run_atomic(TEXT, UUID, UUID, TEXT, TEXT, TEXT, INT, JSONB) TO service_role;


-- ----------------------------------------------------------------------------
-- 4. Atomic RPC: Renew Reconciliation Lease (Fencing Verification)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.renew_reconciliation_lease_atomic(
    p_run_id UUID,
    p_lease_token UUID,
    p_lease_ttl_seconds INT DEFAULT 120
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_now TIMESTAMPTZ := pg_catalog.now();
    v_ttl INT;
    v_new_expires_at TIMESTAMPTZ;
    v_updated_count INT;
BEGIN
    v_ttl := GREATEST(15, COALESCE(p_lease_ttl_seconds, 120));
    v_new_expires_at := v_now + (v_ttl || ' seconds')::interval;

    IF p_run_id IS NULL OR p_lease_token IS NULL THEN
        RETURN jsonb_build_object('renewed', false, 'reason', 'INVALID_ARGUMENTS');
    END IF;

    UPDATE public.billing_reconciliation_runs
    SET lease_expires_at = v_new_expires_at,
        last_heartbeat_at = v_now
    WHERE id = p_run_id
      AND lease_token = p_lease_token
      AND status = 'running'
      AND lease_expires_at > v_now;

    GET DIAGNOSTICS v_updated_count = ROW_COUNT;

    IF v_updated_count = 1 THEN
        RETURN jsonb_build_object(
            'renewed', true,
            'lease_expires_at', v_new_expires_at
        );
    ELSE
        RETURN jsonb_build_object(
            'renewed', false,
            'reason', 'LEASE_LOST_OR_EXPIRED'
        );
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.renew_reconciliation_lease_atomic(UUID, UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renew_reconciliation_lease_atomic(UUID, UUID, INT) TO service_role;


-- ----------------------------------------------------------------------------
-- 5. Atomic RPC: Verify and Claim HMAC Nonce for Replay Protection
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_and_claim_hmac_nonce_atomic(
    p_nonce_hash TEXT,
    p_ttl_seconds INT DEFAULT 300
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_now TIMESTAMPTZ := pg_catalog.now();
    v_clean_nonce_hash TEXT;
    v_expires_at TIMESTAMPTZ;
    v_inserted boolean := false;
BEGIN
    v_clean_nonce_hash := pg_catalog.btrim(COALESCE(p_nonce_hash, ''));
    v_expires_at := v_now + (GREATEST(60, COALESCE(p_ttl_seconds, 300)) || ' seconds')::interval;

    IF pg_catalog.length(v_clean_nonce_hash) <> 64 OR v_clean_nonce_hash !~ '^[a-f0-9]{64}$' THEN
        RETURN jsonb_build_object('valid', false, 'reason', 'INVALID_NONCE_HASH_FORMAT');
    END IF;

    -- Lazily clean up expired nonces
    DELETE FROM public.billing_reconciliation_hmac_nonces
    WHERE expires_at < v_now;

    -- Attempt atomic insertion
    INSERT INTO public.billing_reconciliation_hmac_nonces (
        nonce_hash,
        expires_at
    ) VALUES (
        v_clean_nonce_hash,
        v_expires_at
    ) ON CONFLICT (nonce_hash) DO NOTHING;

    IF FOUND THEN
        RETURN jsonb_build_object('valid', true);
    ELSE
        RETURN jsonb_build_object('valid', false, 'reason', 'REPLAYED_NONCE_DETECTED');
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_and_claim_hmac_nonce_atomic(TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_and_claim_hmac_nonce_atomic(TEXT, INT) TO service_role;

COMMIT;
