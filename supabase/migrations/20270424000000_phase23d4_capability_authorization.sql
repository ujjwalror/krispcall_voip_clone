-- ==============================================================================
-- PHASE 23D.4: CANONICAL PHONE NUMBER CAPABILITY AUTHORIZATION
-- LOCAL MIGRATION ONLY — DO NOT APPLY TO REMOTE PRODUCTION DATABASE DIRECTLY
-- Additive indexing and event types for canonical capability lifecycle progression.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. GIN INDEX ON public.phone_numbers(capabilities_state)
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_phone_numbers_capabilities_state_gin
ON public.phone_numbers USING GIN (capabilities_state);

-- ------------------------------------------------------------------------------
-- 2. EXPAND EVENT TYPES IN public.phone_number_lifecycle_events
-- ------------------------------------------------------------------------------
DO $$
BEGIN
    -- Drop existing inline check constraint if present and replace with expanded set
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'phone_number_lifecycle_events_event_type_check'
    ) THEN
        ALTER TABLE public.phone_number_lifecycle_events
        DROP CONSTRAINT phone_number_lifecycle_events_event_type_check;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_phone_number_lifecycle_events_event_type_23d4'
    ) THEN
        ALTER TABLE public.phone_number_lifecycle_events
        ADD CONSTRAINT chk_phone_number_lifecycle_events_event_type_23d4
        CHECK (
            event_type IN (
                'PURCHASE_REQUESTED',
                'PURCHASE_CONFIRMED',
                'PURCHASE_FAILED',
                'PURCHASE_RECONCILED',
                'ASSIGNED',
                'UNASSIGNED',
                'ROUTING_CHANGED',
                'SUSPENDED',
                'REACTIVATED',
                'RELEASE_REQUESTED',
                'RELEASE_BLOCKED',
                'RELEASE_CONFIRMED',
                'PORT_IN_REQUESTED',
                'PORT_IN_COMPLETED',
                'PORT_IN_FAILED',
                'PORT_OUT_REQUESTED',
                'PORT_OUT_AUTHORIZED',
                'PORT_OUT_COMPLETED',
                'PORT_FREEZE_CHANGED',
                'COMPLIANCE_CHANGED',
                'CAPABILITY_CHANGED',
                'CAPABILITY_REFRESHED'
            )
        );
    END IF;
END $$;
