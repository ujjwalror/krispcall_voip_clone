-- ====================================================================
-- VOIP HUB — PHASE 19E.1 MIGRATION
-- VOICEMAIL FOUNDATION SCHEMA & ENTITLEMENT MATRIX SEED
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
        VALUES (v_pro_id, 'pro', true) -- fallback
        ON CONFLICT (plan_id, feature_code) DO NOTHING;

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
END $$;

-- Unique index on provider_recording_sid for idempotency
CREATE UNIQUE INDEX IF NOT EXISTS idx_voicemails_recording_sid ON public.voicemails (provider_recording_sid);

-- Indexes for tenant querying and inbox filtering
CREATE INDEX IF NOT EXISTS idx_voicemails_org_created ON public.voicemails (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_voicemails_org_read ON public.voicemails (organization_id, is_read);
CREATE INDEX IF NOT EXISTS idx_voicemails_phone_num ON public.voicemails (phone_number_id);

-- RLS Enablement
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

-- Permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.voicemails TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.voicemails TO service_role;
