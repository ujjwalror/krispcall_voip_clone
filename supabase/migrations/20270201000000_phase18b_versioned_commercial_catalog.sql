-- Phase 18B: Versioned Commercial SaaS Catalog & Entitlement Schema Foundations
-- Evolve existing plans/entitlements schema with immutable plan versions, version-aware entitlements, and lifecycle fields.

-- 1. Evolve public.plans with stable_key
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS stable_key TEXT;
UPDATE public.plans SET stable_key = code WHERE stable_key IS NULL;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'plans_stable_key_key'
    ) THEN
        ALTER TABLE public.plans ADD CONSTRAINT plans_stable_key_key UNIQUE (stable_key);
    END IF;
EXCEPTION
    WHEN OTHERS THEN NULL;
END $$;

-- 2. Create public.plan_versions table
CREATE TABLE IF NOT EXISTS public.plan_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
    billing_interval TEXT CHECK (billing_interval IN ('month', 'year')) DEFAULT 'month',
    currency TEXT NOT NULL DEFAULT 'usd',
    base_price_minor BIGINT CHECK (base_price_minor IS NULL OR base_price_minor >= 0),
    seat_price_minor BIGINT CHECK (seat_price_minor IS NULL OR seat_price_minor >= 0),
    effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    effective_until TIMESTAMPTZ,
    stripe_product_id TEXT,
    stripe_base_price_id TEXT,
    stripe_seat_price_id TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(plan_id, version)
);

-- 3. Enforce Immutable Published Plan Version Principle via trigger
CREATE OR REPLACE FUNCTION public.enforce_plan_version_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF (OLD.status IN ('published', 'retired')) THEN
        IF (OLD.base_price_minor IS DISTINCT FROM NEW.base_price_minor OR
            OLD.seat_price_minor IS DISTINCT FROM NEW.seat_price_minor OR
            OLD.billing_interval IS DISTINCT FROM NEW.billing_interval OR
            OLD.currency IS DISTINCT FROM NEW.currency OR
            OLD.plan_id IS DISTINCT FROM NEW.plan_id OR
            OLD.version IS DISTINCT FROM NEW.version) THEN
            RAISE EXCEPTION 'Immutable plan version error: Published or retired plan version core attributes cannot be modified. Create a new plan version instead.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_plan_version_immutability ON public.plan_versions;
CREATE TRIGGER trg_enforce_plan_version_immutability
    BEFORE UPDATE ON public.plan_versions
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_plan_version_immutability();

-- 4. Create public.plan_version_entitlements table
CREATE TABLE IF NOT EXISTS public.plan_version_entitlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_version_id UUID NOT NULL REFERENCES public.plan_versions(id) ON DELETE CASCADE,
    feature_code TEXT NOT NULL REFERENCES public.features(code) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    numeric_value NUMERIC CHECK (numeric_value IS NULL OR numeric_value >= 0),
    text_value TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(plan_version_id, feature_code)
);

-- 5. Add lifecycle and plan_version columns to public.organization_subscriptions
ALTER TABLE public.organization_subscriptions
    ADD COLUMN IF NOT EXISTS plan_version_id UUID REFERENCES public.plan_versions(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS grace_period_ends_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;

DO $$
BEGIN
    ALTER TABLE public.organization_subscriptions DROP CONSTRAINT IF EXISTS organization_subscriptions_status_check;
    ALTER TABLE public.organization_subscriptions ADD CONSTRAINT organization_subscriptions_status_check
        CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'expired', 'suspended', 'incomplete', 'incomplete_expired', 'unpaid'));
EXCEPTION
    WHEN OTHERS THEN NULL;
END $$;

-- 6. RLS Security Configuration
ALTER TABLE public.plan_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_version_entitlements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plan_versions_select_policy ON public.plan_versions;
CREATE POLICY plan_versions_select_policy ON public.plan_versions
    FOR SELECT TO authenticated
    USING (
        (status = 'published' AND plan_id IN (SELECT id FROM public.plans WHERE is_active = TRUE AND is_public = TRUE))
        OR id IN (
            SELECT os.plan_version_id
            FROM public.organization_subscriptions os
            JOIN public.profiles p ON p.organization_id = os.organization_id
            WHERE p.id = auth.uid() AND p.active = TRUE AND os.plan_version_id IS NOT NULL
        )
    );

DROP POLICY IF EXISTS plan_version_entitlements_select_policy ON public.plan_version_entitlements;
CREATE POLICY plan_version_entitlements_select_policy ON public.plan_version_entitlements
    FOR SELECT TO authenticated
    USING (
        plan_version_id IN (
            SELECT id FROM public.plan_versions WHERE status = 'published'
        )
        OR plan_version_id IN (
            SELECT os.plan_version_id
            FROM public.organization_subscriptions os
            JOIN public.profiles p ON p.organization_id = os.organization_id
            WHERE p.id = auth.uid() AND p.active = TRUE AND os.plan_version_id IS NOT NULL
        )
    );

REVOKE ALL ON TABLE public.plan_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.plan_versions TO authenticated;

REVOKE ALL ON TABLE public.plan_version_entitlements FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.plan_version_entitlements TO authenticated;

-- 7. Seed Legacy Version for dev_unlimited Plan (status = draft, is_public = false)
DO $$
DECLARE
    v_plan_id UUID;
    v_version_id UUID;
BEGIN
    SELECT id INTO v_plan_id FROM public.plans WHERE code = 'dev_unlimited';
    IF v_plan_id IS NOT NULL THEN
        INSERT INTO public.plan_versions (plan_id, version, status, billing_interval, currency, base_price_minor, seat_price_minor, metadata)
        VALUES (v_plan_id, 1, 'draft', 'month', 'usd', 0, 0, '{"legacy": true, "environment": "development"}'::jsonb)
        ON CONFLICT (plan_id, version) DO NOTHING
        RETURNING id INTO v_version_id;

        IF v_version_id IS NULL THEN
            SELECT id INTO v_version_id FROM public.plan_versions WHERE plan_id = v_plan_id AND version = 1;
        END IF;

        IF v_version_id IS NOT NULL THEN
            -- Backfill version-aware entitlements for dev_unlimited from plan_entitlements
            INSERT INTO public.plan_version_entitlements (plan_version_id, feature_code, enabled, numeric_value, text_value)
            SELECT v_version_id, feature_code, enabled, numeric_value, text_value
            FROM public.plan_entitlements
            WHERE plan_id = v_plan_id
            ON CONFLICT (plan_version_id, feature_code) DO NOTHING;

            -- Associate dev_unlimited org subscriptions with legacy plan_version_id if currently null
            UPDATE public.organization_subscriptions
            SET plan_version_id = v_version_id
            WHERE plan_id = v_plan_id AND plan_version_id IS NULL;
        END IF;
    END IF;
END $$;
