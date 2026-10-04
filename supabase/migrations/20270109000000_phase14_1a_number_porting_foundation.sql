-- ====================================================================
-- MIGRATION: PHASE 14.1A PROVIDER-NEUTRAL NUMBER PORTING FOUNDATION
-- Date: 2027-01-09
-- Establishes durable, multi-tenant number_port_operations table,
-- provider-neutral workflow modes, domain status constraints,
-- and strict server-authoritative RLS security policies.
-- LOCAL MIGRATION ONLY — DO NOT EXECUTE REMOTELY AUTOMATICALLY.
-- ====================================================================

-- 1. Create public.number_port_operations table
CREATE TABLE IF NOT EXISTS public.number_port_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    phone_number_id UUID REFERENCES public.phone_numbers(id) ON DELETE SET NULL,
    phone_number_e164 TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('port_in', 'port_out')),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (
        status IN (
            'draft', 'portability_checking', 'requirements_pending', 'ready_for_submission',
            'submitted', 'under_review', 'action_required', 'waiting_for_signature',
            'in_progress', 'scheduled', 'completed', 'canceled', 'failed',
            'manual_review_required', 'requested', 'instructions_ready', 'port_out_pending',
            'carrier_processing', 'ported_out'
        )
    ),
    workflow_mode TEXT NOT NULL DEFAULT 'unknown' CHECK (
        workflow_mode IN ('automated_api', 'assisted_manual', 'unsupported', 'requires_recheck', 'unknown')
    ),
    idempotency_key TEXT UNIQUE,
    request_fingerprint TEXT NULL,
    provider TEXT NOT NULL DEFAULT 'twilio',
    provider_port_id TEXT NULL,
    provider_status TEXT NULL,
    capability_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    required_action_state TEXT NULL,
    carrier_name TEXT NULL,
    account_number_encrypted TEXT NULL,
    porting_pin_encrypted TEXT NULL,
    compliance_profile_id UUID REFERENCES public.organization_compliance_profiles(id) ON DELETE SET NULL,
    retail_amount_minor BIGINT DEFAULT 0,
    retail_currency TEXT DEFAULT 'USD',
    provider_cost_minor BIGINT DEFAULT 0,
    provider_cost_currency TEXT DEFAULT 'USD',
    price_snapshot_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    customer_message TEXT NULL,
    internal_rejection_code TEXT NULL,
    sanitized_error_message TEXT NULL,
    scheduled_transfer_at TIMESTAMPTZ NULL,
    completed_at TIMESTAMPTZ NULL,
    last_reconciled_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance & query isolation
CREATE INDEX IF NOT EXISTS idx_number_port_ops_org_id ON public.number_port_operations(organization_id);
CREATE INDEX IF NOT EXISTS idx_number_port_ops_phone_e164 ON public.number_port_operations(phone_number_e164);
CREATE INDEX IF NOT EXISTS idx_number_port_ops_status ON public.number_port_operations(status);
CREATE INDEX IF NOT EXISTS idx_number_port_ops_direction_status ON public.number_port_operations(direction, status);
CREATE INDEX IF NOT EXISTS idx_number_port_ops_provider_port_id ON public.number_port_operations(provider, provider_port_id) WHERE provider_port_id IS NOT NULL;

-- Updated_at trigger
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'update_number_port_operations_updated_at'
    ) THEN
        CREATE TRIGGER update_number_port_operations_updated_at
            BEFORE UPDATE ON public.number_port_operations
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- 2. Row Level Security (RLS)
ALTER TABLE public.number_port_operations ENABLE ROW LEVEL SECURITY;

-- Revoke mutation rights from PUBLIC, anon, authenticated
REVOKE ALL ON public.number_port_operations FROM PUBLIC, anon, authenticated;

-- Grant SELECT to authenticated users (evaluated by RLS policy)
GRANT SELECT ON public.number_port_operations TO authenticated;

-- Grant FULL permissions to service_role (used by server-side services)
GRANT ALL ON public.number_port_operations TO service_role;

-- SELECT policy for Owner and Admin roles
DO $$
BEGIN
    DROP POLICY IF EXISTS "Owner and Admin read number port operations" ON public.number_port_operations;
    CREATE POLICY "Owner and Admin read number port operations"
    ON public.number_port_operations
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.organization_id = number_port_operations.organization_id
              AND p.role IN ('owner', 'admin')
        )
    );
END $$;
