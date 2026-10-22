-- ==============================================================================
-- PHASE 23D.6 ADDITIVE MIGRATION: DURABLE NUMBER RELEASE SAGA & INTERLOCK
-- Date: 2027-04-26
-- Monotonically follows: 20270425000000_phase23d5_assignment_and_routing.sql
-- Purely additive. Preserves all legacy columns, existing rows, and constraints.
-- ==============================================================================

-- 1. ADDITIVE COLUMNS ON public.number_release_operations
ALTER TABLE public.number_release_operations
ADD COLUMN IF NOT EXISTS actor_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS error_category TEXT NULL,
ADD COLUMN IF NOT EXISTS validated_at TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ NULL;

-- 2. INDEXES FOR PERFORMANCE & SAFE CONCURRENCY
CREATE INDEX IF NOT EXISTS idx_number_release_ops_canonical_state
ON public.number_release_operations(canonical_state);

CREATE INDEX IF NOT EXISTS idx_number_release_ops_org_phone
ON public.number_release_operations(organization_id, phone_number_id);

-- CONCURRENCY INVARIANT: Active Release Operation Partial Unique Index on Canonical State
CREATE UNIQUE INDEX IF NOT EXISTS uq_release_ops_active_canonical
ON public.number_release_operations (phone_number_id)
WHERE canonical_state NOT IN ('RELEASED', 'FAILED');

-- ACTIVE TRAFFIC COVERAGE: Index all non-terminal call statuses
CREATE INDEX IF NOT EXISTS idx_calls_active_traffic_phone
ON public.calls(phone_number_id, status)
WHERE status NOT IN ('completed', 'failed', 'busy', 'no-answer', 'canceled', 'missed', 'blocked');

CREATE INDEX IF NOT EXISTS idx_calls_active_traffic_from_to
ON public.calls(organization_id, from_number, to_number, status)
WHERE status NOT IN ('completed', 'failed', 'busy', 'no-answer', 'canceled', 'missed', 'blocked');

-- IN-FLIGHT MESSAGING COVERAGE: Index non-terminal outbound messages
CREATE INDEX IF NOT EXISTS idx_messages_active_outbound
ON public.messages(organization_id, from_number, status, direction)
WHERE direction = 'outbound' AND status NOT IN ('delivered', 'undelivered', 'failed');

-- ACTIVE PORTING CONFLICT COVERAGE: Index active port-in and port-out orders
CREATE INDEX IF NOT EXISTS idx_number_port_ops_active_e164
ON public.number_port_operations(organization_id, phone_number_e164, status)
WHERE status IN ('requested', 'instructions_ready', 'port_out_pending', 'carrier_processing', 'in_progress');
