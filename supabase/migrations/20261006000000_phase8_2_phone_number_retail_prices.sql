-- Phase 8.2 Migration: Phone Number Retail Pricing Foundation
-- Date: 2026-10-06

-- 1. Create public.phone_number_retail_prices table (Option A: Single Active Price Versioning Model)
CREATE TABLE IF NOT EXISTS public.phone_number_retail_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    country_code TEXT NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
    number_type TEXT NOT NULL CHECK (number_type IN ('local', 'mobile', 'toll_free')),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
    monthly_price_minor BIGINT NULL CHECK (monthly_price_minor IS NULL OR monthly_price_minor >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- 2. Partial unique index ensuring at most ONE active retail price per (country_code, number_type, currency)
CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_number_retail_prices_active_unique
ON public.phone_number_retail_prices(country_code, number_type, currency)
WHERE is_active = TRUE;

-- 3. Enable Row Level Security (RLS) - Server-Authoritative Table
ALTER TABLE public.phone_number_retail_prices ENABLE ROW LEVEL SECURITY;

-- 4. Remove any customer-facing client access policies
DROP POLICY IF EXISTS "Authenticated users can view active phone number retail prices" ON public.phone_number_retail_prices;

-- 5. Revoke direct table privileges from anon & authenticated client roles
REVOKE ALL ON public.phone_number_retail_prices FROM authenticated, anon;

-- 6. Grant backend service-role full administrative management access
GRANT SELECT, INSERT, UPDATE, DELETE ON public.phone_number_retail_prices TO service_role;
