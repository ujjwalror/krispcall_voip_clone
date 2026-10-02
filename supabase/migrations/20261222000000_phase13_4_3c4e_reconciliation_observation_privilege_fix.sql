-- ============================================================================
-- PUBLIC SAAS PHASE 13.4.3C SUBPHASE C.4E.RECON.A — OBSERVATION PRIVILEGE HARDENING
-- Date: 2026-12-22
-- Explicitly revokes all table-level privileges on public.billing_reconciliation_finding_observations
-- from service_role to strip default table creation ACL grants (UPDATE, DELETE),
-- then grants SELECT and INSERT ONLY.
-- Scoped strictly to public.billing_reconciliation_finding_observations.
-- LOCAL MIGRATION ONLY — SUBJECT TO MANUAL DBA REVIEW. DO NOT EXECUTE REMOTELY AUTOMATICALLY.
-- ============================================================================

BEGIN;

-- Explicitly revoke all privileges on observation snapshots from service_role to clear default ACL grants
REVOKE ALL ON public.billing_reconciliation_finding_observations FROM service_role;

-- Grant SELECT and INSERT ONLY to service_role (UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER remain REVOKED)
GRANT SELECT, INSERT ON public.billing_reconciliation_finding_observations TO service_role;

COMMIT;
