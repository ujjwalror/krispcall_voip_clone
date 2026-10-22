-- ==============================================================================
-- PHASE 23D.5: CANONICAL PHONE NUMBER ASSIGNMENT & ROUTING ARCHITECTURE
-- LOCAL MIGRATION ONLY — DO NOT APPLY TO REMOTE PRODUCTION DATABASE DIRECTLY
-- Additive indexing and constraints for canonical assignment & routing authority.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. COMPOSITE INDEX ON public.phone_numbers FOR ASSIGNMENT LOOKUPS
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_phone_numbers_canonical_assignment
ON public.phone_numbers (organization_id, assignment_target_type, assignment_target_id);

-- ------------------------------------------------------------------------------
-- 2. PARTIAL INDEX FOR UNASSIGNED POOL
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_phone_numbers_unassigned_pool
ON public.phone_numbers (organization_id)
WHERE assignment_target_type = 'UNASSIGNED_POOL' OR assignment_target_type IS NULL;
