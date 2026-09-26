-- ====================================================================
-- PUBLIC SAAS PHASE 6.2 — PROVIDER-NEUTRAL BILLING FOUNDATION
-- Date: 2026-09-30
-- Creates public.prices, public.billing_outbox_events, adds price_id
-- to organization_subscriptions, enforces plan/price consistency,
-- and configures provider-neutral RLS policies & constraints.
-- ====================================================================

-- 1. Create provider-neutral public.prices table
CREATE TABLE IF NOT EXISTS public.prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES public.plans(id) ON DELETE RESTRICT,
    currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    billing_interval TEXT NOT NULL CHECK (billing_interval IN ('monthly', 'annual')),
    pricing_model TEXT NOT NULL CHECK (pricing_model IN ('per_seat', 'base_plus_seat', 'flat', 'custom')),
    unit_amount_minor BIGINT NULL CHECK (unit_amount_minor IS NULL OR unit_amount_minor >= 0),
    base_amount_minor BIGINT NULL CHECK (base_amount_minor IS NULL OR base_amount_minor >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT check_pricing_model_amounts CHECK (
        (pricing_model = 'per_seat' AND unit_amount_minor IS NOT NULL) OR
        (pricing_model = 'flat' AND base_amount_minor IS NOT NULL) OR
        (pricing_model = 'base_plus_seat' AND base_amount_minor IS NOT NULL AND unit_amount_minor IS NOT NULL) OR
        (pricing_model = 'custom')
    )
);

-- Partial unique index ensuring at most ONE active public price for non-custom (plan_id, currency, billing_interval, pricing_model)
CREATE UNIQUE INDEX IF NOT EXISTS idx_prices_active_unique
ON public.prices(plan_id, currency, billing_interval, pricing_model)
WHERE is_active = TRUE AND pricing_model <> 'custom';

-- 2. Add price_id to public.organization_subscriptions (Nullable for internal/dev_unlimited plans)
ALTER TABLE public.organization_subscriptions
ADD COLUMN IF NOT EXISTS price_id UUID NULL REFERENCES public.prices(id) ON DELETE RESTRICT;

-- 3. Plan / Price consistency trigger on organization_subscriptions
CREATE OR REPLACE FUNCTION public.check_subscription_plan_price_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_price_plan_id UUID;
BEGIN
    IF NEW.price_id IS NOT NULL THEN
        SELECT p.plan_id INTO v_price_plan_id
        FROM public.prices AS p
        WHERE p.id = NEW.price_id;

        IF v_price_plan_id IS NULL THEN
            RAISE EXCEPTION 'Referenced price_id (%) does not exist in public.prices.', NEW.price_id;
        END IF;

        IF v_price_plan_id <> NEW.plan_id THEN
            RAISE EXCEPTION 'Plan mismatch: Subscription plan_id (%) does not match selected price plan_id (%).', NEW.plan_id, v_price_plan_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

-- Revoke direct execution privileges on internal trigger function
REVOKE ALL ON FUNCTION public.check_subscription_plan_price_consistency() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_subscription_plan_price_consistency() FROM anon;
REVOKE ALL ON FUNCTION public.check_subscription_plan_price_consistency() FROM authenticated;

DROP TRIGGER IF EXISTS trg_check_subscription_plan_price_consistency ON public.organization_subscriptions;
CREATE TRIGGER trg_check_subscription_plan_price_consistency
BEFORE INSERT OR UPDATE ON public.organization_subscriptions
FOR EACH ROW
EXECUTE FUNCTION public.check_subscription_plan_price_consistency();

-- 4. Create internal public.billing_outbox_events table
CREATE TABLE IF NOT EXISTS public.billing_outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    processed_at TIMESTAMPTZ NULL,
    last_error TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Efficient worker index for pending/retryable outbox events
CREATE INDEX IF NOT EXISTS idx_billing_outbox_worker
ON public.billing_outbox_events (status, available_at, created_at);

-- 5. RLS & Security for public.prices
ALTER TABLE public.prices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "prices_select_policy" ON public.prices;
CREATE POLICY "prices_select_policy"
ON public.prices
FOR SELECT
TO authenticated
USING (
    -- Condition A: Price is active and associated plan is active & public
    (
        is_active = TRUE
        AND EXISTS (
            SELECT 1 FROM public.plans AS pl
            WHERE pl.id = prices.plan_id
              AND pl.is_active = TRUE
              AND pl.is_public = TRUE
        )
    )
    OR
    -- Condition B: Price is referenced by the authenticated user's organization subscription (grandfathered inactive price support)
    (
        prices.id IN (
            SELECT s.price_id
            FROM public.organization_subscriptions AS s
            JOIN public.profiles AS prof ON prof.organization_id = s.organization_id
            WHERE prof.id = auth.uid()
              AND prof.active = TRUE
              AND s.price_id IS NOT NULL
        )
    )
);

REVOKE ALL ON public.prices FROM PUBLIC;
REVOKE ALL ON public.prices FROM anon;
GRANT SELECT ON public.prices TO authenticated;

-- 6. RLS & Security for public.billing_outbox_events (Internal infrastructure: NO direct user access)
ALTER TABLE public.billing_outbox_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.billing_outbox_events FROM PUBLIC;
REVOKE ALL ON public.billing_outbox_events FROM anon;
REVOKE ALL ON public.billing_outbox_events FROM authenticated;
