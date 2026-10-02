-- ============================================================================
-- PUBLIC SAAS PHASE 13.4.3C SUBPHASE C.4E.RECON.A — FINANCIAL RECONCILIATION DATABASE FOUNDATION
-- Date: 2026-12-21
-- Establishes durable storage tables for financial reconciliation runs, persistent findings,
-- and run observation snapshots.
-- Includes strict constraints for fingerprint uniqueness, scope coherence, lifecycle ordering,
-- evidence sanitization, and service-role-only access control.
-- LOCAL MIGRATION ONLY — SUBJECT TO MANUAL DBA REVIEW. DO NOT EXECUTE REMOTELY AUTOMATICALLY.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Create public.billing_reconciliation_runs table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_reconciliation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_type TEXT NOT NULL CHECK (run_type IN ('full_system', 'organization', 'provider_account', 'targeted')),
    provider_account_id UUID NULL REFERENCES public.billing_provider_accounts(id) ON DELETE RESTRICT,
    organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'partial')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    completed_at TIMESTAMPTZ NULL,
    module_coverage JSONB NOT NULL DEFAULT '{}'::jsonb,
    summary_counts JSONB NOT NULL DEFAULT '{"total_inspected": 0, "findings_open": 0, "findings_resolved": 0}'::jsonb,
    error_info JSONB NOT NULL DEFAULT '{}'::jsonb,
    scope_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT check_run_timestamps CHECK (completed_at IS NULL OR completed_at >= started_at),
    CONSTRAINT check_run_scope_coherence CHECK (
        (run_type <> 'organization' OR organization_id IS NOT NULL) AND
        (run_type <> 'provider_account' OR provider_account_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_billing_recon_runs_status_start 
ON public.billing_reconciliation_runs (status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_recon_runs_org 
ON public.billing_reconciliation_runs (organization_id) WHERE organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_recon_runs_provider_acc 
ON public.billing_reconciliation_runs (provider_account_id) WHERE provider_account_id IS NOT NULL;


-- ----------------------------------------------------------------------------
-- 2. Create public.billing_reconciliation_findings table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_reconciliation_findings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fingerprint TEXT NOT NULL UNIQUE CHECK (pg_catalog.length(pg_catalog.btrim(fingerprint)) = 64 AND fingerprint ~ '^[a-f0-9]{64}$'),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    provider_account_id UUID NOT NULL REFERENCES public.billing_provider_accounts(id) ON DELETE RESTRICT,
    finding_category TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(finding_category)) > 0 AND finding_category ~ '^[A-Z0-9_]+$'),
    severity TEXT NOT NULL CHECK (severity IN ('informational', 'warning', 'financial_risk', 'critical')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved', 'ignored')),
    target_entity_type TEXT NOT NULL CHECK (target_entity_type IN (
        'payment_operation', 'refund_request', 'payment_refund', 'payment_dispute', 
        'financial_hold', 'account_debt', 'wallet_ledger', 'provider_account', 'telecom_reservation'
    )),
    target_entity_id TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(target_entity_id)) > 0),
    stable_discriminator TEXT NOT NULL DEFAULT 'default' CHECK (pg_catalog.length(pg_catalog.btrim(stable_discriminator)) > 0),
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    resolved_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT check_finding_lifecycle_timestamps CHECK (
        first_seen_at <= last_seen_at AND
        (resolved_at IS NULL OR resolved_at >= first_seen_at) AND
        (status <> 'resolved' OR resolved_at IS NOT NULL) AND
        (status = 'resolved' OR resolved_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_billing_recon_findings_status_severity 
ON public.billing_reconciliation_findings (status, severity, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_recon_findings_org 
ON public.billing_reconciliation_findings (organization_id, status);

CREATE INDEX IF NOT EXISTS idx_billing_recon_findings_provider_acc 
ON public.billing_reconciliation_findings (provider_account_id, status);

CREATE INDEX IF NOT EXISTS idx_billing_recon_findings_entity 
ON public.billing_reconciliation_findings (target_entity_type, target_entity_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_billing_reconciliation_findings_updated_at'
    ) THEN
        CREATE TRIGGER trg_billing_reconciliation_findings_updated_at
            BEFORE UPDATE ON public.billing_reconciliation_findings
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;


-- ----------------------------------------------------------------------------
-- 3. Create public.billing_reconciliation_finding_observations table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_reconciliation_finding_observations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES public.billing_reconciliation_runs(id) ON DELETE RESTRICT,
    finding_id UUID NOT NULL REFERENCES public.billing_reconciliation_findings(id) ON DELETE RESTRICT,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    evidence_hash TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(evidence_hash)) = 64 AND evidence_hash ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT uq_billing_recon_finding_obs_run_finding UNIQUE (run_id, finding_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_recon_obs_run 
ON public.billing_reconciliation_finding_observations (run_id);

CREATE INDEX IF NOT EXISTS idx_billing_recon_obs_finding 
ON public.billing_reconciliation_finding_observations (finding_id, observed_at DESC);


-- ----------------------------------------------------------------------------
-- 4. Security & Access Control (Service Role ONLY)
-- ----------------------------------------------------------------------------
ALTER TABLE public.billing_reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_reconciliation_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_reconciliation_finding_observations ENABLE ROW LEVEL SECURITY;

-- Revoke default public/anon/authenticated access to enforce service_role control
REVOKE ALL ON public.billing_reconciliation_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.billing_reconciliation_findings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.billing_reconciliation_finding_observations FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON public.billing_reconciliation_runs TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.billing_reconciliation_findings TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.billing_reconciliation_finding_observations TO service_role;

-- RLS policies explicitly restricting operation to service_role
CREATE POLICY service_role_access_billing_reconciliation_runs 
ON public.billing_reconciliation_runs
FOR ALL TO service_role
USING (true)
WITH CHECK (true);

CREATE POLICY service_role_access_billing_reconciliation_findings 
ON public.billing_reconciliation_findings
FOR ALL TO service_role
USING (true)
WITH CHECK (true);

CREATE POLICY service_role_access_billing_reconciliation_finding_obs 
ON public.billing_reconciliation_finding_observations
FOR ALL TO service_role
USING (true)
WITH CHECK (true);

COMMIT;
