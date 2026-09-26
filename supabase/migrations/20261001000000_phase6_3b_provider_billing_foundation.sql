-- ====================================================================
-- PUBLIC SAAS PHASE 6.3B — PROVIDER MAPPING & WEBHOOK DATABASE FOUNDATION
-- Date: 2026-10-01
-- Creates public.billing_provider_customers, public.billing_provider_prices,
-- public.billing_provider_subscriptions, public.billing_webhook_events,
-- and configures RLS and privilege revokes.
-- ====================================================================

-- 1. Create provider customer mapping table
CREATE TABLE IF NOT EXISTS public.billing_provider_customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL CHECK (provider = pg_catalog.lower(pg_catalog.btrim(provider)) AND pg_catalog.length(pg_catalog.btrim(provider)) > 0),
    provider_customer_id TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(provider_customer_id)) > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT uq_billing_provider_customers_provider_cust_id UNIQUE (provider, provider_customer_id),
    CONSTRAINT uq_billing_provider_customers_org_provider UNIQUE (organization_id, provider)
);

-- 2. Create provider price mapping table
CREATE TABLE IF NOT EXISTS public.billing_provider_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    price_id UUID NOT NULL REFERENCES public.prices(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL CHECK (provider = pg_catalog.lower(pg_catalog.btrim(provider)) AND pg_catalog.length(pg_catalog.btrim(provider)) > 0),
    provider_price_id TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(provider_price_id)) > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT uq_billing_provider_prices_provider_price_id UNIQUE (provider, provider_price_id),
    CONSTRAINT uq_billing_provider_prices_price_provider UNIQUE (price_id, provider)
);

-- 3. Create provider subscription mapping table
CREATE TABLE IF NOT EXISTS public.billing_provider_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_subscription_id UUID NOT NULL REFERENCES public.organization_subscriptions(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL CHECK (provider = pg_catalog.lower(pg_catalog.btrim(provider)) AND pg_catalog.length(pg_catalog.btrim(provider)) > 0),
    provider_subscription_id TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(provider_subscription_id)) > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT uq_billing_provider_subs_provider_sub_id UNIQUE (provider, provider_subscription_id),
    CONSTRAINT uq_billing_provider_subs_org_sub_provider UNIQUE (organization_subscription_id, provider)
);

-- 4. Create provider webhook event deduplication and retry table
CREATE TABLE IF NOT EXISTS public.billing_webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL CHECK (provider = pg_catalog.lower(pg_catalog.btrim(provider)) AND pg_catalog.length(pg_catalog.btrim(provider)) > 0),
    provider_event_id TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(provider_event_id)) > 0),
    event_type TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(event_type)) > 0),
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    processing_started_at TIMESTAMPTZ NULL,
    processed_at TIMESTAMPTZ NULL,
    last_error TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT uq_billing_webhook_events_provider_event UNIQUE (provider, provider_event_id)
);

-- Worker index for pending and retryable webhook events
CREATE INDEX IF NOT EXISTS idx_billing_webhook_worker
ON public.billing_webhook_events (status, available_at, created_at);

-- 5. Enable RLS on all four tables
ALTER TABLE public.billing_provider_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_provider_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_provider_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_webhook_events ENABLE ROW LEVEL SECURITY;

-- 6. Revoke direct access from PUBLIC, anon, and authenticated
REVOKE ALL ON public.billing_provider_customers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.billing_provider_prices FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.billing_provider_subscriptions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.billing_webhook_events FROM PUBLIC, anon, authenticated;
