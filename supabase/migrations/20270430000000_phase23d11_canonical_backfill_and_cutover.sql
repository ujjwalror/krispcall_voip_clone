-- ==============================================================================
-- PHASE 23D.11: CANONICAL NUMBER DATA BACKFILL & CUTOVER ENGINE
-- LOCAL MIGRATION ONLY — DO NOT APPLY TO REMOTE PRODUCTION DATABASE DIRECTLY
-- Additive schema for discovery, classification, durable backfill plans,
-- concurrent worker locking, manual review queue, and shadow comparison.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. DURABLE BACKFILL PLAN TABLE
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.telecom_number_backfill_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    phone_number_id UUID NULL REFERENCES public.phone_numbers(id) ON DELETE CASCADE,
    phone_number_e164 TEXT NOT NULL,
    source_evidence JSONB NOT NULL,
    target_canonical_state JSONB NOT NULL,
    classification TEXT NOT NULL CHECK (
        classification IN (
            'DETERMINISTIC_FROM_LOCAL_DATA',
            'REQUIRES_PROVIDER_RECONCILIATION',
            'REQUIRES_OPERATOR_REVIEW',
            'PROTECTED_RESOURCE_DO_NOT_TOUCH',
            'CANNOT_SAFELY_INFER'
        )
    ),
    confidence_score NUMERIC NOT NULL DEFAULT 1.0,
    evidence_reason TEXT NOT NULL,
    planned_action TEXT NOT NULL CHECK (
        planned_action IN (
            'INSERT_CANONICAL',
            'UPDATE_CANONICAL',
            'NO_OP',
            'MANUAL_REVIEW',
            'PROVIDER_RECONCILE',
            'QUARANTINE_NO_OP'
        )
    ),
    status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (
        status IN (
            'PLANNED',
            'CLAIMED',
            'APPLIED',
            'FAILED',
            'CONFLICT',
            'STALE_SOURCE',
            'SKIPPED'
        )
    ),
    claim_token TEXT NULL,
    claimed_at TIMESTAMPTZ NULL,
    applied_at TIMESTAMPTZ NULL,
    source_version_hash TEXT NOT NULL,
    error_reason TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backfill_plans_org_status
ON public.telecom_number_backfill_plans (organization_id, status);

CREATE INDEX IF NOT EXISTS idx_backfill_plans_claim_concurrency
ON public.telecom_number_backfill_plans (status, claimed_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_backfill_plans_idempotent_source
ON public.telecom_number_backfill_plans (organization_id, phone_number_e164, source_version_hash);

-- ------------------------------------------------------------------------------
-- 2. MANUAL REVIEW QUEUE TABLE
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.telecom_backfill_manual_review_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    phone_number_id UUID NULL REFERENCES public.phone_numbers(id) ON DELETE SET NULL,
    phone_number_e164 TEXT NOT NULL,
    conflict_type TEXT NOT NULL,
    reason TEXT NOT NULL,
    source_evidence JSONB NOT NULL,
    operator_action_required TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RESOLVED', 'DISMISSED')),
    resolution_notes TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backfill_manual_review_status
ON public.telecom_backfill_manual_review_queue (organization_id, status);

-- ------------------------------------------------------------------------------
-- 3. PROVIDER RECONCILIATION QUEUE TABLE (MOCKED / PLANNED ONLY)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.telecom_backfill_provider_reconciliation_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    phone_number_id UUID NULL REFERENCES public.phone_numbers(id) ON DELETE SET NULL,
    phone_number_e164 TEXT NOT NULL,
    remote_resource_sid TEXT NULL,
    suspected_provider_account_id UUID NULL REFERENCES public.telecom_provider_accounts(id) ON DELETE SET NULL,
    verification_reason TEXT NOT NULL,
    source_evidence JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (
        status IN (
            'QUEUED',
            'IN_RECONCILIATION',
            'CONFIRMED_MATCH',
            'ORPHAN_CARRIER',
            'MANUAL_INTERVENTION_REQUIRED'
        )
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------------------------
-- 4. ATOMIC FUNCTION: CLAIM BATCH FOR CONCURRENT WORKERS
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_backfill_plan_batch(
    p_worker_token TEXT,
    p_batch_size INT DEFAULT 10
)
RETURNS TABLE (
    plan_id UUID,
    organization_id UUID,
    phone_number_id UUID,
    phone_number_e164 TEXT,
    source_evidence JSONB,
    target_canonical_state JSONB,
    classification TEXT,
    planned_action TEXT,
    source_version_hash TEXT
) AS $$
BEGIN
    RETURN QUERY
    WITH claimed AS (
        SELECT id
        FROM public.telecom_number_backfill_plans
        WHERE status = 'PLANNED'
           OR (status = 'CLAIMED' AND claimed_at < NOW() - INTERVAL '5 minutes')
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT p_batch_size
    )
    UPDATE public.telecom_number_backfill_plans bp
    SET status = 'CLAIMED',
        claim_token = p_worker_token,
        claimed_at = NOW(),
        updated_at = NOW()
    FROM claimed
    WHERE bp.id = claimed.id
    RETURNING 
        bp.id,
        bp.organization_id,
        bp.phone_number_id,
        bp.phone_number_e164,
        bp.source_evidence,
        bp.target_canonical_state,
        bp.classification,
        bp.planned_action,
        bp.source_version_hash;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------------------------
-- 5. ATOMIC FUNCTION: APPLY CANONICAL NUMBER BACKFILL
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_canonical_number_backfill_atomic(
    p_plan_id UUID,
    p_worker_token TEXT
)
RETURNS JSONB AS $$
DECLARE
    v_plan RECORD;
    v_phone RECORD;
    v_target JSONB;
    v_current_hash TEXT;
    v_target_ownership TEXT;
    v_target_service TEXT;
    v_target_capabilities JSONB;
    v_target_assignment_type TEXT;
    v_target_assignment_id UUID;
    v_target_provider_account_id UUID;
    v_target_resource_record_id UUID;
    v_target_compliance TEXT;
    v_target_porting TEXT;
    v_target_locked BOOLEAN;
BEGIN
    -- 1. Fetch and verify claimed plan
    SELECT * INTO v_plan
    FROM public.telecom_number_backfill_plans
    WHERE id = p_plan_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'PLAN_NOT_FOUND');
    END IF;

    IF v_plan.status = 'APPLIED' THEN
        RETURN jsonb_build_object('success', true, 'idempotent', true, 'status', 'ALREADY_APPLIED');
    END IF;

    IF v_plan.status != 'CLAIMED' OR v_plan.claim_token != p_worker_token THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_CLAIM_TOKEN_OR_STATUS');
    END IF;

    -- 2. Protected Pilot Quarantine Guard
    IF v_plan.classification = 'PROTECTED_RESOURCE_DO_NOT_TOUCH' OR v_plan.planned_action = 'QUARANTINE_NO_OP' THEN
        UPDATE public.telecom_number_backfill_plans
        SET status = 'APPLIED',
            applied_at = NOW(),
            updated_at = NOW()
        WHERE id = p_plan_id;

        RETURN jsonb_build_object(
            'success', true,
            'protected_pilot', true,
            'action', 'QUARANTINE_PRESERVED'
        );
    END IF;

    -- 3. Non-deterministic / Review actions
    IF v_plan.planned_action IN ('MANUAL_REVIEW', 'PROVIDER_RECONCILE', 'NO_OP') THEN
        IF v_plan.planned_action = 'MANUAL_REVIEW' THEN
            INSERT INTO public.telecom_backfill_manual_review_queue (
                organization_id, phone_number_id, phone_number_e164, conflict_type,
                reason, source_evidence, operator_action_required
            ) VALUES (
                v_plan.organization_id, v_plan.phone_number_id, v_plan.phone_number_e164,
                v_plan.classification, v_plan.evidence_reason, v_plan.source_evidence,
                'Operator must manually verify conflicting legacy records.'
            );
        END IF;

        IF v_plan.planned_action = 'PROVIDER_RECONCILE' THEN
            INSERT INTO public.telecom_backfill_provider_reconciliation_queue (
                organization_id, phone_number_id, phone_number_e164,
                remote_resource_sid, verification_reason, source_evidence
            ) VALUES (
                v_plan.organization_id, v_plan.phone_number_id, v_plan.phone_number_e164,
                v_plan.source_evidence->>'remote_resource_id',
                v_plan.evidence_reason, v_plan.source_evidence
            );
        END IF;

        UPDATE public.telecom_number_backfill_plans
        SET status = 'SKIPPED',
            applied_at = NOW(),
            updated_at = NOW()
        WHERE id = p_plan_id;

        RETURN jsonb_build_object('success', true, 'action', v_plan.planned_action, 'status', 'QUEUED_OR_SKIPPED');
    END IF;

    -- 4. Verify Source Row & Staleness Check (SOURCE_CHANGED_SINCE_PLAN)
    IF v_plan.phone_number_id IS NOT NULL THEN
        SELECT * INTO v_phone
        FROM public.phone_numbers
        WHERE id = v_plan.phone_number_id
        FOR UPDATE;

        IF NOT FOUND THEN
            UPDATE public.telecom_number_backfill_plans
            SET status = 'FAILED', error_reason = 'SOURCE_PHONE_ROW_VANISHED', updated_at = NOW()
            WHERE id = p_plan_id;
            RETURN jsonb_build_object('success', false, 'error', 'SOURCE_PHONE_ROW_VANISHED');
        END IF;

        -- Verify hash
        v_current_hash := md5(
            COALESCE(v_phone.phone_number, '') || ':' ||
            COALESCE(v_phone.status, '') || ':' ||
            COALESCE(v_phone.active::text, '') || ':' ||
            COALESCE(v_phone.capabilities_voice::text, '') || ':' ||
            COALESCE(v_phone.capabilities_sms::text, '') || ':' ||
            COALESCE(v_phone.inbound_routing_type, '') || ':' ||
            COALESCE(v_phone.inbound_routing_destination_id::text, '')
        );

        IF v_current_hash != v_plan.source_version_hash THEN
            UPDATE public.telecom_number_backfill_plans
            SET status = 'STALE_SOURCE',
                error_reason = 'SOURCE_CHANGED_SINCE_PLAN: Source phone row modified since dry-run plan generation.',
                updated_at = NOW()
            WHERE id = p_plan_id;

            RETURN jsonb_build_object('success', false, 'error', 'SOURCE_CHANGED_SINCE_PLAN');
        END IF;

        -- 5. Extract canonical target parameters
        v_target := v_plan.target_canonical_state;
        v_target_ownership := v_target->>'ownership_state';
        v_target_service := v_target->>'service_state';
        v_target_capabilities := COALESCE(v_target->'capabilities_state', '{}'::jsonb);
        v_target_assignment_type := v_target->>'assignment_target_type';
        v_target_assignment_id := CASE WHEN v_target->>'assignment_target_id' IS NOT NULL THEN (v_target->>'assignment_target_id')::uuid ELSE NULL END;
        v_target_provider_account_id := CASE WHEN v_target->>'provider_account_id' IS NOT NULL THEN (v_target->>'provider_account_id')::uuid ELSE NULL END;
        v_target_resource_record_id := CASE WHEN v_target->>'provider_resource_record_id' IS NOT NULL THEN (v_target->>'provider_resource_record_id')::uuid ELSE NULL END;
        v_target_compliance := COALESCE(v_target->>'compliance_state', 'NOT_REQUIRED');
        v_target_porting := COALESCE(v_target->>'porting_state', 'NONE');
        v_target_locked := COALESCE((v_target->>'port_out_locked')::boolean, TRUE);

        -- 6. Apply canonical dimensions to phone_numbers
        UPDATE public.phone_numbers
        SET ownership_state = v_target_ownership,
            service_state = v_target_service,
            capabilities_state = v_target_capabilities,
            assignment_target_type = v_target_assignment_type,
            assignment_target_id = v_target_assignment_id,
            provider_account_id = v_target_provider_account_id,
            provider_resource_record_id = v_target_resource_record_id,
            compliance_state = v_target_compliance,
            porting_state = v_target_porting,
            port_out_locked = v_target_locked,
            updated_at = NOW()
        WHERE id = v_plan.phone_number_id;

        -- 7. Ensure Authoritative Provider Resource Record exists if remote SID provided
        IF v_target->>'remote_resource_id' IS NOT NULL AND v_target_provider_account_id IS NOT NULL THEN
            INSERT INTO public.telecom_provider_resource_records (
                organization_id, provider_account_id, provider, remote_resource_id,
                phone_number_e164, domain_phone_number_id, status, last_verified_at
            ) VALUES (
                v_plan.organization_id,
                v_target_provider_account_id,
                'TWILIO',
                v_target->>'remote_resource_id',
                v_plan.phone_number_e164,
                v_plan.phone_number_id,
                'active',
                NOW()
            )
            ON CONFLICT (provider_account_id, remote_resource_id)
            DO UPDATE SET
                domain_phone_number_id = EXCLUDED.domain_phone_number_id,
                last_verified_at = NOW();
        END IF;

        -- 8. Mark Plan APPLIED
        UPDATE public.telecom_number_backfill_plans
        SET status = 'APPLIED',
            applied_at = NOW(),
            updated_at = NOW()
        WHERE id = p_plan_id;

        RETURN jsonb_build_object(
            'success', true,
            'phone_number_id', v_plan.phone_number_id,
            'ownership_state', v_target_ownership,
            'service_state', v_target_service
        );
    END IF;

    RETURN jsonb_build_object('success', false, 'error', 'UNSUPPORTED_ACTION');
END;
$$ LANGUAGE plpgsql;
