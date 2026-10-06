-- ====================================================================
-- MIGRATION: PHASE 17G.1B LEGACY NUMBER QUARANTINE & DATA INTEGRITY HARDENING
-- Date: 2027-01-18
-- Establishes legacy quarantine semantics for unmapped non-provider-owned records,
-- neutralizes stale billable resource eligibility without destroying audit history,
-- enforces partial unique index for current-ownership E.164 numbers per organization,
-- and protects verified provider-reconciled records completely.
-- LOCAL MIGRATION FILE ONLY — DO NOT APPLY REMOTELY AUTOMATICALLY.
-- ====================================================================

DO $$
DECLARE
    rec2_status TEXT;
    rec3_status TEXT;
    rec4_status TEXT;
    rec5_status TEXT;
    rec6_status TEXT;
    rec7_status TEXT;
    rec1_status TEXT;
    rec1_active BOOLEAN;
    rec1_sid TEXT;
    dup_count INT;
BEGIN
    -- ====================================================================
    -- 1. PRE-MUTATION FAIL-CLOSED ASSERTIONS (EXACT RECORD SCOPING)
    -- ====================================================================

    -- Verify Record 2
    SELECT status INTO rec2_status FROM public.phone_numbers
    WHERE id = 'f3c94a9d-fe66-402a-a023-550c0c1bcfb0' AND organization_id = '00000000-0000-0000-0000-000000000001' AND phone_number = '+12025550288';
    IF rec2_status IS NULL OR rec2_status != 'active' THEN
        RAISE EXCEPTION 'MIGRATION PRESTATE FAILURE: Record 2 (f3c94a9d) not in expected active state!';
    END IF;

    -- Verify Record 3
    SELECT status INTO rec3_status FROM public.phone_numbers
    WHERE id = '38e50215-2b40-48f5-b365-142f92f1d4fe' AND organization_id = '00000000-0000-0000-0000-000000000001' AND phone_number = '+12025550199';
    IF rec3_status IS NULL OR rec3_status != 'active' THEN
        RAISE EXCEPTION 'MIGRATION PRESTATE FAILURE: Record 3 (38e50215) not in expected active state!';
    END IF;

    -- Verify Record 4
    SELECT status INTO rec4_status FROM public.phone_numbers
    WHERE id = 'e1442d39-fab1-4887-a245-c7e1c51f9842' AND organization_id = '00000000-0000-0000-0000-000000000001' AND phone_number = '+12025550377';
    IF rec4_status IS NULL OR rec4_status != 'released' THEN
        RAISE EXCEPTION 'MIGRATION PRESTATE FAILURE: Record 4 (e1442d39) not in expected released state!';
    END IF;

    -- Verify Record 5
    SELECT status INTO rec5_status FROM public.phone_numbers
    WHERE id = 'cec8ed6c-d0ad-4039-b529-286b58e6a5e3' AND organization_id = '00000000-0000-0000-0000-000000000001' AND phone_number = '+12025550377';
    IF rec5_status IS NULL OR rec5_status != 'active' THEN
        RAISE EXCEPTION 'MIGRATION PRESTATE FAILURE: Record 5 (cec8ed6c) not in expected active state!';
    END IF;

    -- Verify Record 6
    SELECT status INTO rec6_status FROM public.phone_numbers
    WHERE id = '45e7e811-04be-4442-97a1-bf38afef1dc9' AND organization_id = '00000000-0000-0000-0000-000000000001' AND phone_number = '+12025550466';
    IF rec6_status IS NULL OR rec6_status != 'ported_out' THEN
        RAISE EXCEPTION 'MIGRATION PRESTATE FAILURE: Record 6 (45e7e811) not in expected ported_out state!';
    END IF;

    -- Verify Record 7
    SELECT status INTO rec7_status FROM public.phone_numbers
    WHERE id = '6eed699c-b1b1-4346-96e7-508f66359955' AND organization_id = '00000000-0000-0000-0000-000000000001' AND phone_number = '+12025550466';
    IF rec7_status IS NULL OR rec7_status != 'active' THEN
        RAISE EXCEPTION 'MIGRATION PRESTATE FAILURE: Record 7 (6eed699c) not in expected active state!';
    END IF;

    -- ====================================================================
    -- 2. STATUS CHECK CONSTRAINTS UPDATES
    -- ====================================================================

    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_phone_numbers_status') THEN
        ALTER TABLE public.phone_numbers DROP CONSTRAINT chk_phone_numbers_status;
    END IF;

    ALTER TABLE public.phone_numbers
    ADD CONSTRAINT chk_phone_numbers_status
    CHECK (status IN ('active', 'inactive', 'suspended', 'released', 'ported_out', 'legacy_quarantined'));

    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'phone_number_lifecycle_states_lifecycle_state_check') THEN
        ALTER TABLE public.phone_number_lifecycle_states DROP CONSTRAINT phone_number_lifecycle_states_lifecycle_state_check;
    END IF;

    ALTER TABLE public.phone_number_lifecycle_states
    ADD CONSTRAINT phone_number_lifecycle_states_lifecycle_state_check
    CHECK (lifecycle_state IN ('active', 'past_due', 'suspended', 'release_pending', 'released', 'ported_out', 'legacy_quarantined'));

    -- ====================================================================
    -- 3. LEGACY DATA REMEDIATION (RECORDS 2–7 ONLY)
    -- ====================================================================

    -- Transition active legacy records to legacy_quarantined and active = false
    UPDATE public.phone_numbers
    SET status = 'legacy_quarantined',
        active = false,
        updated_at = NOW()
    WHERE id IN (
        'f3c94a9d-fe66-402a-a023-550c0c1bcfb0',
        '38e50215-2b40-48f5-b365-142f92f1d4fe',
        'cec8ed6c-d0ad-4039-b529-286b58e6a5e3',
        '6eed699c-b1b1-4346-96e7-508f66359955'
    )
    AND organization_id = '00000000-0000-0000-0000-000000000001';

    -- Update lifecycle states for active legacy records
    UPDATE public.phone_number_lifecycle_states
    SET lifecycle_state = 'legacy_quarantined',
        allow_telecom_usage = FALSE,
        updated_at = NOW()
    WHERE phone_number_id IN (
        'f3c94a9d-fe66-402a-a023-550c0c1bcfb0',
        '38e50215-2b40-48f5-b365-142f92f1d4fe',
        'cec8ed6c-d0ad-4039-b529-286b58e6a5e3',
        '6eed699c-b1b1-4346-96e7-508f66359955'
    )
    AND organization_id = '00000000-0000-0000-0000-000000000001';

    -- Neutralize stale active lifecycle state for historical records (Record 4 & Record 6)
    UPDATE public.phone_numbers
    SET active = false,
        updated_at = NOW()
    WHERE id IN ('e1442d39-fab1-4887-a245-c7e1c51f9842', '45e7e811-04be-4442-97a1-bf38afef1dc9')
      AND organization_id = '00000000-0000-0000-0000-000000000001';

    UPDATE public.phone_number_lifecycle_states
    SET lifecycle_state = 'released',
        allow_telecom_usage = FALSE,
        updated_at = NOW()
    WHERE phone_number_id = 'e1442d39-fab1-4887-a245-c7e1c51f9842'
      AND organization_id = '00000000-0000-0000-0000-000000000001';

    UPDATE public.phone_number_lifecycle_states
    SET lifecycle_state = 'ported_out',
        allow_telecom_usage = FALSE,
        updated_at = NOW()
    WHERE phone_number_id = '45e7e811-04be-4442-97a1-bf38afef1dc9'
      AND organization_id = '00000000-0000-0000-0000-000000000001';

    -- Terminate active organization_billable_resources using exact UUID scoping and effective_end_at
    UPDATE public.organization_billable_resources
    SET status = 'terminated',
        effective_end_at = NOW(),
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'termination_reason', 'LEGACY_RECONCILIATION_QUARANTINE',
            'terminated_at', NOW()
        ),
        updated_at = NOW()
    WHERE organization_id = '00000000-0000-0000-0000-000000000001'
      AND resource_type = 'phone_number'
      AND resource_id IN (
        'f3c94a9d-fe66-402a-a023-550c0c1bcfb0',
        '38e50215-2b40-48f5-b365-142f92f1d4fe',
        'e1442d39-fab1-4887-a245-c7e1c51f9842',
        'cec8ed6c-d0ad-4039-b529-286b58e6a5e3',
        '45e7e811-04be-4442-97a1-bf38afef1dc9',
        '6eed699c-b1b1-4346-96e7-508f66359955'
      )
      AND status = 'active';

    -- ====================================================================
    -- 4. RECORD 1 ABSOLUTE PROTECTION ASSERTION
    -- ====================================================================

    SELECT status, active, twilio_phone_number_sid INTO rec1_status, rec1_active, rec1_sid
    FROM public.phone_numbers
    WHERE id = '03edd0bc-b025-49e6-8171-a0c2fcd6cb78';

    IF rec1_status IS NULL OR rec1_status != 'active' OR rec1_active != true OR rec1_sid != 'PN832a10dec98cbb48d02033a83afecff3' THEN
        RAISE EXCEPTION 'CRITICAL MIGRATION SAFETY FAILURE: Reconciled Record 1 status, active flag, or provider SID was altered!';
    END IF;

    -- ====================================================================
    -- 5. DUPLICATE ACTIVE CONCURRENCY SAFETY ASSERTION
    -- ====================================================================

    SELECT COUNT(*) INTO dup_count
    FROM (
        SELECT organization_id, phone_number
        FROM public.phone_numbers
        WHERE status IN ('active', 'suspended')
        GROUP BY organization_id, phone_number
        HAVING COUNT(*) > 1
    ) dups;

    IF dup_count > 0 THEN
        RAISE EXCEPTION 'CRITICAL MIGRATION SAFETY FAILURE: Unexpected duplicate active E.164 records detected!';
    END IF;
END $$;

-- ====================================================================
-- 6. PARTIAL UNIQUE INDEX CREATION FOR CURRENT OWNERSHIP
-- ====================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_numbers_org_current_ownership_e164
ON public.phone_numbers (organization_id, phone_number)
WHERE status IN ('active', 'suspended');

CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_number_lifecycle_states_org_current_ownership_e164
ON public.phone_number_lifecycle_states (organization_id, phone_number_e164)
WHERE lifecycle_state IN ('active', 'past_due', 'suspended', 'release_pending');
