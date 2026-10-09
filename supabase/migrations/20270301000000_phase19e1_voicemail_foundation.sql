-- ====================================================================
-- VOIP HUB — PHASE 19E.1 / 19E.1B MIGRATION
-- VOICEMAIL FOUNDATION, PROVIDER-MANAGED RECORDINGS, RECORDING PRICING POLICIES,
-- AND DURABLE PROVIDER DELETION SCHEMA
-- ====================================================================

-- 1. Ensure commercial plans exist in public.plans
INSERT INTO public.plans (code, stable_key, name, description, is_active, is_public, sort_order)
VALUES
  ('starter', 'starter', 'Starter', 'Starter tier plan for individuals and small teams', true, true, 1),
  ('pro', 'pro', 'Pro', 'Pro tier plan with IVR, Call Queues, Voicemail and advanced tools', true, true, 2),
  ('business', 'business', 'Business', 'Business tier plan for enterprise teams and advanced call centers', true, true, 3)
ON CONFLICT (code) DO NOTHING;

-- Add unanswered_call_strategy column to phone_numbers
ALTER TABLE public.phone_numbers
    ADD COLUMN IF NOT EXISTS unanswered_call_strategy TEXT NOT NULL DEFAULT 'dismiss';

-- 2. Seed 'voicemail' feature in public.features
INSERT INTO public.features (code, name, value_type, description)
VALUES ('voicemail', 'Voicemail', 'boolean', 'Voicemail recording, storage, and inbox capabilities')
ON CONFLICT (code) DO NOTHING;

-- 3. Seed explicit Voicemail feature entitlement matrix in public.plan_entitlements
-- Starter  = false
-- Pro      = true
-- Business = true
DO $$
DECLARE
    v_starter_id UUID;
    v_pro_id UUID;
    v_business_id UUID;
BEGIN
    SELECT id INTO v_starter_id FROM public.plans WHERE code = 'starter';
    SELECT id INTO v_pro_id FROM public.plans WHERE code = 'pro';
    SELECT id INTO v_business_id FROM public.plans WHERE code = 'business';

    -- STARTER: Voicemail = DISABLED
    IF v_starter_id IS NOT NULL THEN
        INSERT INTO public.plan_entitlements (plan_id, feature_code, enabled)
        VALUES (v_starter_id, 'voicemail', false)
        ON CONFLICT (plan_id, feature_code) DO UPDATE SET enabled = EXCLUDED.enabled;
    END IF;

    -- PRO: Voicemail = ENABLED
    IF v_pro_id IS NOT NULL THEN
        INSERT INTO public.plan_entitlements (plan_id, feature_code, enabled)
        VALUES (v_pro_id, 'voicemail', true)
        ON CONFLICT (plan_id, feature_code) DO UPDATE SET enabled = EXCLUDED.enabled;
    END IF;

    -- BUSINESS: Voicemail = ENABLED
    IF v_business_id IS NOT NULL THEN
        INSERT INTO public.plan_entitlements (plan_id, feature_code, enabled)
        VALUES (v_business_id, 'voicemail', true)
        ON CONFLICT (plan_id, feature_code) DO UPDATE SET enabled = EXCLUDED.enabled;
    END IF;
END $$;

-- 4. Create public.voicemails table
CREATE TABLE IF NOT EXISTS public.voicemails (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    phone_number_id UUID NULL REFERENCES public.phone_numbers(id) ON DELETE SET NULL,
    call_id UUID NULL REFERENCES public.calls(id) ON DELETE SET NULL,
    provider_call_sid TEXT NOT NULL,
    provider_recording_sid TEXT NOT NULL,
    caller_number TEXT NOT NULL,
    called_number TEXT NOT NULL,
    recording_url TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'completed',
    storage_model TEXT NOT NULL DEFAULT 'PROVIDER_MANAGED',
    provider_deletion_status TEXT NOT NULL DEFAULT 'active',
    provider_deleted_at TIMESTAMPTZ NULL,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ NULL
);

-- Constraints for voicemails
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_voicemails_status') THEN
        ALTER TABLE public.voicemails
            ADD CONSTRAINT chk_voicemails_status
            CHECK (status IN ('completed', 'failed', 'deleted'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_voicemails_storage_model') THEN
        ALTER TABLE public.voicemails
            ADD CONSTRAINT chk_voicemails_storage_model
            CHECK (storage_model IN ('PROVIDER_MANAGED', 'VOIPHUB_PRIVATE'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_voicemails_provider_deletion_status') THEN
        ALTER TABLE public.voicemails
            ADD CONSTRAINT chk_voicemails_provider_deletion_status
            CHECK (provider_deletion_status IN ('active', 'delete_requested', 'provider_delete_pending', 'provider_deleted', 'delete_failed', 'gated'));
    END IF;
END $$;

-- Unique index on provider_recording_sid for idempotency
CREATE UNIQUE INDEX IF NOT EXISTS idx_voicemails_recording_sid ON public.voicemails (provider_recording_sid);

-- Indexes for tenant querying and inbox filtering
CREATE INDEX IF NOT EXISTS idx_voicemails_org_created ON public.voicemails (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_voicemails_org_read ON public.voicemails (organization_id, is_read);
CREATE INDEX IF NOT EXISTS idx_voicemails_phone_num ON public.voicemails (phone_number_id);

-- RLS Enablement for voicemails
ALTER TABLE public.voicemails ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS voicemails_org_select_policy ON public.voicemails;
CREATE POLICY voicemails_org_select_policy ON public.voicemails
    FOR SELECT TO authenticated
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles WHERE id = auth.uid()
        )
    );

DROP POLICY IF EXISTS voicemails_org_update_policy ON public.voicemails;
CREATE POLICY voicemails_org_update_policy ON public.voicemails
    FOR UPDATE TO authenticated
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles WHERE id = auth.uid()
        )
    )
    WITH CHECK (
        organization_id IN (
            SELECT organization_id FROM public.profiles WHERE id = auth.uid()
        )
    );

DROP POLICY IF EXISTS voicemails_org_delete_policy ON public.voicemails;
CREATE POLICY voicemails_org_delete_policy ON public.voicemails
    FOR DELETE TO authenticated
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles WHERE id = auth.uid()
        )
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.voicemails TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.voicemails TO service_role;

-- 5. Create public.voicemail_recording_pricing_policies table
CREATE TABLE IF NOT EXISTS public.voicemail_recording_pricing_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_key TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL DEFAULT 'twilio',
    usage_type TEXT NOT NULL CHECK (usage_type IN ('recording_capture', 'recording_storage')),
    markup_bps INTEGER NOT NULL DEFAULT 1000 CHECK (markup_bps >= 0),
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
    effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    effective_to TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed initial recording capture and recording storage policies (1000 bps = 10% markup)
INSERT INTO public.voicemail_recording_pricing_policies (policy_key, provider, usage_type, markup_bps, version, status)
VALUES
  ('default_twilio_recording_capture_v1', 'twilio', 'recording_capture', 1000, 1, 'active'),
  ('default_twilio_recording_storage_v1', 'twilio', 'recording_storage', 1000, 1, 'active')
ON CONFLICT (policy_key) DO NOTHING;

ALTER TABLE public.voicemail_recording_pricing_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recording_policies_select_policy ON public.voicemail_recording_pricing_policies;
CREATE POLICY recording_policies_select_policy ON public.voicemail_recording_pricing_policies
    FOR SELECT TO authenticated USING (true);

GRANT SELECT ON TABLE public.voicemail_recording_pricing_policies TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.voicemail_recording_pricing_policies TO service_role;

-- 6. Create public.voicemail_recording_usage_snapshots table
CREATE TABLE IF NOT EXISTS public.voicemail_recording_usage_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    call_id UUID NULL REFERENCES public.calls(id) ON DELETE SET NULL,
    voicemail_id UUID NULL REFERENCES public.voicemails(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'twilio',
    provider_recording_sid TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    provider_unit_cost_micro BIGINT NOT NULL DEFAULT 0,
    provider_calculated_cost_micro BIGINT NOT NULL DEFAULT 0,
    markup_bps INTEGER NOT NULL DEFAULT 1000,
    customer_calculated_cost_micro BIGINT NOT NULL DEFAULT 0,
    customer_retail_charge_minor INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    pricing_policy_key TEXT NOT NULL,
    pricing_policy_version INTEGER NOT NULL DEFAULT 1,
    settlement_status TEXT NOT NULL DEFAULT 'settled' CHECK (settlement_status IN ('settled', 'failed_closed', 'pending')),
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recording_snapshots_org ON public.voicemail_recording_usage_snapshots (organization_id, created_at DESC);

ALTER TABLE public.voicemail_recording_usage_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recording_snapshots_select_policy ON public.voicemail_recording_usage_snapshots;
CREATE POLICY recording_snapshots_select_policy ON public.voicemail_recording_usage_snapshots
    FOR SELECT TO authenticated
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles WHERE id = auth.uid()
        )
    );

GRANT SELECT ON TABLE public.voicemail_recording_usage_snapshots TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.voicemail_recording_usage_snapshots TO service_role;

-- 7. Create public.provider_recording_deletion_operations table
CREATE TABLE IF NOT EXISTS public.provider_recording_deletion_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    voicemail_id UUID NOT NULL REFERENCES public.voicemails(id) ON DELETE CASCADE,
    provider_recording_sid TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'provider_deleted', 'delete_failed', 'gated')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_provider_deletion_voicemail UNIQUE (voicemail_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_deletion_org ON public.provider_recording_deletion_operations (organization_id, status);

ALTER TABLE public.provider_recording_deletion_operations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS provider_deletion_select_policy ON public.provider_recording_deletion_operations;
CREATE POLICY provider_deletion_select_policy ON public.provider_recording_deletion_operations
    FOR SELECT TO authenticated
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles WHERE id = auth.uid()
        )
    );

GRANT SELECT ON TABLE public.provider_recording_deletion_operations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.provider_recording_deletion_operations TO service_role;
