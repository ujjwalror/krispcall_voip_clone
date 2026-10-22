-- ============================================================================
-- PHASE 20.1B: PREPAID TELECOM CONCURRENCY AND BOUNDED EXPOSURE HARDENING
-- LOCAL PREPARATION ONLY - DO NOT APPLY REMOTELY
--
-- Objective:
-- 1. Adds organization-level concurrent active call risk limits to prevent
--    simultaneous calls racing against the shared prepaid balance.
-- 2. Documents the prepaid fail-closed invariants and bounded provider exposure.
-- ============================================================================

-- 1. Add max_concurrent_voice_calls risk limit column to organization_billing_controls
ALTER TABLE public.organization_billing_controls
ADD COLUMN IF NOT EXISTS max_concurrent_voice_calls INT NULL DEFAULT 5
CHECK (max_concurrent_voice_calls IS NULL OR max_concurrent_voice_calls > 0);

COMMENT ON COLUMN public.organization_billing_controls.max_concurrent_voice_calls IS
'Infrastructure safety risk-control threshold for concurrent active voice calls per organization. Prevents wallet exhaustion races. NOT a commercial subscription entitlement.';

-- 2. Index active voice reservations by organization for fast concurrency checks
CREATE INDEX IF NOT EXISTS idx_telecom_usage_reservations_org_active_voice
ON public.telecom_usage_reservations(organization_id, status, service_type)
WHERE status = 'active' AND service_type IN ('voice_outbound', 'voice_inbound');
