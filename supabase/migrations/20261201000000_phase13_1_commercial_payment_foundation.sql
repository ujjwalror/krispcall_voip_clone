-- ====================================================================
-- PUBLIC SAAS PHASE 13.1 — CANONICAL PAYMENT FOUNDATION & LEDGERS (HARDENED)
-- Date: 2026-12-01
-- Establishes provider-neutral billing_payment_operations, append-only
-- billing_credit_ledger, organization_billable_resources, price versions,
-- organization_billing_controls, and billing_invoices mirror.
-- Integrates DB-enforced append-only triggers, atomic FOR UPDATE credit RPC,
-- full price-version non-overlap triggers [) range semantics, strict RLS, and security revokes.
-- DO NOT EXECUTE REMOTELY AUTOMATICALLY — Subject to manual DBA review.
-- ====================================================================

-- 1. Create public.billing_payment_operations table
CREATE TABLE IF NOT EXISTS public.billing_payment_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    operation_type TEXT NOT NULL CHECK (operation_type IN ('number_purchase', 'subscription_charge', 'seat_addon', 'credit_topup', 'custom')),
    provider TEXT NOT NULL DEFAULT 'stripe' CHECK (pg_catalog.length(pg_catalog.btrim(provider)) > 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN (
            'pending',
            'requires_customer_action',
            'authorized',
            'capture_pending',
            'captured',
            'cancel_pending',
            'canceled',
            'failed',
            'refund_pending',
            'partially_refunded',
            'refunded',
            'reconciliation_required',
            'manual_review_required'
        )
    ),
    amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
    currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
    provider_payment_id TEXT NULL,
    provider_customer_id TEXT NULL,
    price_snapshot_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    telecom_operation_id UUID NULL REFERENCES public.provider_number_operations(id) ON DELETE SET NULL,
    authorization_expires_at TIMESTAMPTZ NULL,
    attempt_count INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    failure_code TEXT NULL,
    failure_message TEXT NULL,
    reconciliation_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT uq_billing_payment_ops_org_idempotency UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_billing_payment_ops_org 
ON public.billing_payment_operations(organization_id);

CREATE INDEX IF NOT EXISTS idx_billing_payment_ops_status 
ON public.billing_payment_operations(status);

CREATE INDEX IF NOT EXISTS idx_billing_payment_ops_provider_id 
ON public.billing_payment_operations(provider, provider_payment_id) 
WHERE provider_payment_id IS NOT NULL;

-- Trigger for updated_at
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_billing_payment_ops_updated_at'
    ) THEN
        CREATE TRIGGER trg_billing_payment_ops_updated_at
            BEFORE UPDATE ON public.billing_payment_operations
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;


-- 2. Create public.billing_credit_ledger table (Append-only audit trail)
CREATE TABLE IF NOT EXISTS public.billing_credit_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    entry_type TEXT NOT NULL CHECK (entry_type IN ('grant', 'consumption', 'expiration', 'adjustment')),
    amount_minor BIGINT NOT NULL CHECK (amount_minor <> 0),
    balance_after_minor BIGINT NOT NULL CHECK (balance_after_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
    description TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(description)) > 0),
    reference_type TEXT NULL CHECK (reference_type IS NULL OR reference_type IN ('payment_operation', 'invoice', 'admin_action', 'promo')),
    reference_id TEXT NULL,
    created_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS idx_billing_credit_ledger_org 
ON public.billing_credit_ledger(organization_id, created_at DESC);

-- HARDENED: Database-level trigger prohibiting UPDATE or DELETE on billing_credit_ledger
CREATE OR REPLACE FUNCTION public.prevent_credit_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'IMMUTABLE_CREDIT_LEDGER: Updates and deletions are strictly prohibited on billing_credit_ledger.' USING ERRCODE = '42883';
    RETURN NULL;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_no_mutation_billing_credit_ledger'
    ) THEN
        CREATE TRIGGER trg_no_mutation_billing_credit_ledger
            BEFORE UPDATE OR DELETE ON public.billing_credit_ledger
            FOR EACH ROW EXECUTE FUNCTION public.prevent_credit_ledger_mutation();
    END IF;
END $$;


-- 3. Atomic Credit Ledger Consumption RPC (FOR UPDATE Lock to prevent concurrent race conditions)
CREATE OR REPLACE FUNCTION public.record_credit_ledger_entry_atomic(
    p_organization_id UUID,
    p_entry_type TEXT,
    p_amount_minor BIGINT,
    p_currency TEXT,
    p_description TEXT,
    p_reference_type TEXT DEFAULT NULL,
    p_reference_id TEXT DEFAULT NULL,
    p_created_by UUID DEFAULT NULL
) RETURNS public.billing_credit_ledger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_current_balance BIGINT := 0;
    v_new_balance BIGINT := 0;
    v_new_entry public.billing_credit_ledger;
BEGIN
    -- Input validation
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_organization_id is required.';
    END IF;
    IF p_amount_minor = 0 THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_amount_minor must be non-zero.';
    END IF;

    -- Lock organization row or existing ledger rows to serialize concurrent updates
    PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

    -- Fetch latest balance
    SELECT balance_after_minor INTO v_current_balance
    FROM public.billing_credit_ledger
    WHERE organization_id = p_organization_id
    ORDER BY created_at DESC, id DESC
    LIMIT 1;

    IF v_current_balance IS NULL THEN
        v_current_balance := 0;
    END IF;

    v_new_balance := v_current_balance + p_amount_minor;

    IF v_new_balance < 0 THEN
        RAISE EXCEPTION 'INSUFFICIENT_CREDIT: Credit consumption exceeds available organization balance.' USING ERRCODE = '23514';
    END IF;

    INSERT INTO public.billing_credit_ledger (
        organization_id, entry_type, amount_minor, balance_after_minor,
        currency, description, reference_type, reference_id, created_by
    ) VALUES (
        p_organization_id, p_entry_type, p_amount_minor, v_new_balance,
        COALESCE(p_currency, 'USD'), p_description, p_reference_type, p_reference_id, p_created_by
    ) RETURNING * INTO v_new_entry;

    RETURN v_new_entry;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_credit_ledger_entry_atomic(
    UUID, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, UUID
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_credit_ledger_entry_atomic(
    UUID, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, UUID
) TO service_role;


-- 4. Create public.organization_billable_resources table
CREATE TABLE IF NOT EXISTS public.organization_billable_resources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    resource_type TEXT NOT NULL CHECK (resource_type IN ('phone_number', 'seat', 'addon')),
    resource_id TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(resource_id)) > 0),
    billing_interval TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_interval IN ('monthly', 'annual')),
    contracted_retail_minor BIGINT NOT NULL CHECK (contracted_retail_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'terminated')),
    effective_start_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    effective_end_at TIMESTAMPTZ NULL,
    price_version_id UUID NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS idx_org_billable_resources_org 
ON public.organization_billable_resources(organization_id, status);

-- HARDENED: Partial unique index guaranteeing at most ONE active recurring billable resource per (org, type, resource_id)
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_billable_resource
ON public.organization_billable_resources(organization_id, resource_type, resource_id)
WHERE status = 'active';

-- Trigger for updated_at
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_org_billable_resources_updated_at'
    ) THEN
        CREATE TRIGGER trg_org_billable_resources_updated_at
            BEFORE UPDATE ON public.organization_billable_resources
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;


-- 5. Create public.billable_resource_price_versions table
CREATE TABLE IF NOT EXISTS public.billable_resource_price_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    billable_resource_id UUID NOT NULL REFERENCES public.organization_billable_resources(id) ON DELETE CASCADE,
    contracted_retail_minor BIGINT NOT NULL CHECK (contracted_retail_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
    effective_start_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    effective_end_at TIMESTAMPTZ NULL,
    notice_given_at TIMESTAMPTZ NULL,
    change_reason TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(change_reason)) > 0),
    created_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT check_price_version_dates CHECK (effective_end_at IS NULL OR effective_end_at > effective_start_at)
);

CREATE INDEX IF NOT EXISTS idx_billable_price_versions_resource 
ON public.billable_resource_price_versions(billable_resource_id);

-- HARDENED: Partial unique index enforcing at most ONE active/open-ended price version per billable resource
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_billable_price_version
ON public.billable_resource_price_versions(billable_resource_id)
WHERE effective_end_at IS NULL;

-- HARDENED: Database Trigger ensuring non-overlapping effective price version periods using [) range semantics
-- effective_end_at is EXCLUSIVE. Adjacent periods (e.g. A: Jan 1 -> Jun 1, B: Jun 1 -> Sep 1) are ALLOWED.
-- Overlapping periods (e.g. A: Jan 1 -> Jun 1, C: Mar 1 -> May 1) are REJECTED.
CREATE OR REPLACE FUNCTION public.check_billable_price_version_overlap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.billable_resource_price_versions
        WHERE billable_resource_id = NEW.billable_resource_id
          AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
          AND tstzrange(effective_start_at, COALESCE(effective_end_at, 'infinity'::timestamptz), '[)') &&
              tstzrange(NEW.effective_start_at, COALESCE(NEW.effective_end_at, 'infinity'::timestamptz), '[)')
    ) THEN
        RAISE EXCEPTION 'PRICE_VERSION_OVERLAP: Price version effective range [%, %) overlaps with an existing price version for this billable resource.',
            NEW.effective_start_at, COALESCE(NEW.effective_end_at::text, 'infinity')
            USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_check_billable_price_version_overlap'
    ) THEN
        CREATE TRIGGER trg_check_billable_price_version_overlap
            BEFORE INSERT OR UPDATE ON public.billable_resource_price_versions
            FOR EACH ROW EXECUTE FUNCTION public.check_billable_price_version_overlap();
    END IF;
END $$;

-- Foreign key linkage back to organization_billable_resources
ALTER TABLE public.organization_billable_resources
ADD CONSTRAINT fk_billable_resource_price_version
FOREIGN KEY (price_version_id) REFERENCES public.billable_resource_price_versions(id) ON DELETE SET NULL;


-- 6. Create public.organization_billing_controls table
CREATE TABLE IF NOT EXISTS public.organization_billing_controls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
    max_daily_purchase_spend_minor BIGINT NULL CHECK (max_daily_purchase_spend_minor IS NULL OR max_daily_purchase_spend_minor >= 0),
    max_purchase_velocity_per_hour INT NULL CHECK (max_purchase_velocity_per_hour IS NULL OR max_purchase_velocity_per_hour >= 0),
    max_active_numbers_limit INT NULL CHECK (max_active_numbers_limit IS NULL OR max_active_numbers_limit >= 0),
    disallow_high_cost_destinations BOOLEAN NOT NULL DEFAULT FALSE,
    risk_score_threshold INT NULL CHECK (risk_score_threshold IS NULL OR risk_score_threshold >= 0),
    is_billing_restricted BOOLEAN NOT NULL DEFAULT FALSE,
    restriction_reason TEXT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Trigger for updated_at
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_org_billing_controls_updated_at'
    ) THEN
        CREATE TRIGGER trg_org_billing_controls_updated_at
            BEFORE UPDATE ON public.organization_billing_controls
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;


-- 7. Create public.billing_invoices table (Local mirror of provider invoices)
CREATE TABLE IF NOT EXISTS public.billing_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL DEFAULT 'stripe' CHECK (pg_catalog.length(pg_catalog.btrim(provider)) > 0),
    provider_invoice_id TEXT NOT NULL UNIQUE CHECK (pg_catalog.length(pg_catalog.btrim(provider_invoice_id)) > 0),
    amount_due_minor BIGINT NOT NULL CHECK (amount_due_minor >= 0),
    amount_paid_minor BIGINT NOT NULL CHECK (amount_paid_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
    status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'paid', 'uncollectible', 'void')),
    hosted_invoice_url TEXT NULL,
    invoice_pdf TEXT NULL,
    period_start TIMESTAMPTZ NULL,
    period_end TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS idx_billing_invoices_org 
ON public.billing_invoices(organization_id);

-- Trigger for updated_at
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_billing_invoices_updated_at'
    ) THEN
        CREATE TRIGGER trg_billing_invoices_updated_at
            BEFORE UPDATE ON public.billing_invoices
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;


-- 8. ENABLE ROW LEVEL SECURITY ON ALL TABLES
ALTER TABLE public.billing_payment_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_billable_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billable_resource_price_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_billing_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_invoices ENABLE ROW LEVEL SECURITY;

-- Revoke direct mutation access from client roles
REVOKE ALL ON public.billing_payment_operations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.billing_credit_ledger FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.organization_billable_resources FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.billable_resource_price_versions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.organization_billing_controls FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.billing_invoices FROM PUBLIC, anon, authenticated;

-- Grant full access strictly to service_role
GRANT ALL ON public.billing_payment_operations TO service_role;
GRANT ALL ON public.billing_credit_ledger TO service_role;
GRANT ALL ON public.organization_billable_resources TO service_role;
GRANT ALL ON public.billable_resource_price_versions TO service_role;
GRANT ALL ON public.organization_billing_controls TO service_role;
GRANT ALL ON public.billing_invoices TO service_role;

-- Allow authenticated users to SELECT records belonging strictly to their active organization
CREATE POLICY "authenticated_select_billing_payment_operations"
ON public.billing_payment_operations FOR SELECT TO authenticated
USING (
    organization_id IN (
        SELECT prof.organization_id FROM public.profiles prof
        WHERE prof.id = auth.uid() AND prof.active = TRUE
    )
);

CREATE POLICY "authenticated_select_billing_credit_ledger"
ON public.billing_credit_ledger FOR SELECT TO authenticated
USING (
    organization_id IN (
        SELECT prof.organization_id FROM public.profiles prof
        WHERE prof.id = auth.uid() AND prof.active = TRUE
    )
);

CREATE POLICY "authenticated_select_organization_billable_resources"
ON public.organization_billable_resources FOR SELECT TO authenticated
USING (
    organization_id IN (
        SELECT prof.organization_id FROM public.profiles prof
        WHERE prof.id = auth.uid() AND prof.active = TRUE
    )
);

CREATE POLICY "authenticated_select_billable_resource_price_versions"
ON public.billable_resource_price_versions FOR SELECT TO authenticated
USING (
    billable_resource_id IN (
        SELECT obr.id FROM public.organization_billable_resources obr
        JOIN public.profiles prof ON prof.organization_id = obr.organization_id
        WHERE prof.id = auth.uid() AND prof.active = TRUE
    )
);

CREATE POLICY "authenticated_select_organization_billing_controls"
ON public.organization_billing_controls FOR SELECT TO authenticated
USING (
    organization_id IN (
        SELECT prof.organization_id FROM public.profiles prof
        WHERE prof.id = auth.uid() AND prof.active = TRUE
    )
);

CREATE POLICY "authenticated_select_billing_invoices"
ON public.billing_invoices FOR SELECT TO authenticated
USING (
    organization_id IN (
        SELECT prof.organization_id FROM public.profiles prof
        WHERE prof.id = auth.uid() AND prof.active = TRUE
    )
);

GRANT SELECT ON public.billing_payment_operations TO authenticated;
GRANT SELECT ON public.billing_credit_ledger TO authenticated;
GRANT SELECT ON public.organization_billable_resources TO authenticated;
GRANT SELECT ON public.billable_resource_price_versions TO authenticated;
GRANT SELECT ON public.organization_billing_controls TO authenticated;
GRANT SELECT ON public.billing_invoices TO authenticated;
