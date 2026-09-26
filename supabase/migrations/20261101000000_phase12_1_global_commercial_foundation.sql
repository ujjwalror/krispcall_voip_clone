-- ====================================================================
-- MIGRATION: PHASE 12.1 GLOBAL COMMERCIAL ENABLEMENT & PRICING FOUNDATION (HARDENED)
-- Date: 2026-11-01
-- Establishes server-authoritative marketplace launch enablements, durable
-- pricing policy rules, and canonical Individual profile name extensions.
-- DO NOT EXECUTE REMOTELY AUTOMATICALLY — Must be applied manually by database administrator.
-- ====================================================================

-- 1. Create public.marketplace_launch_enablements table
CREATE TABLE IF NOT EXISTS public.marketplace_launch_enablements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL DEFAULT 'twilio',
    country_code VARCHAR(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
    number_type TEXT NOT NULL CHECK (number_type IN ('local', 'mobile', 'toll_free')),
    is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_launch_enablement UNIQUE (provider, country_code, number_type)
);

CREATE INDEX IF NOT EXISTS idx_launch_enablements_lookup 
ON public.marketplace_launch_enablements(provider, country_code, number_type);

-- Trigger for updated_at
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'update_marketplace_launch_enablements_updated_at'
    ) THEN
        CREATE TRIGGER update_marketplace_launch_enablements_updated_at
            BEFORE UPDATE ON public.marketplace_launch_enablements
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- Enable RLS on marketplace_launch_enablements
ALTER TABLE public.marketplace_launch_enablements ENABLE ROW LEVEL SECURITY;

-- Revoke direct table privileges from client roles
REVOKE ALL ON public.marketplace_launch_enablements FROM authenticated, anon;

-- Grant backend service-role full administrative management access
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketplace_launch_enablements TO service_role;

-- Service role full management RLS policy
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'Allow service_role full management on marketplace_launch_enablements'
    ) THEN
        CREATE POLICY "Allow service_role full management on marketplace_launch_enablements"
            ON public.marketplace_launch_enablements
            FOR ALL
            TO service_role
            USING (true)
            WITH CHECK (true);
    END IF;
END $$;


-- 2. Create public.phone_number_pricing_policies table
CREATE TABLE IF NOT EXISTS public.phone_number_pricing_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL DEFAULT 'twilio',
    country_code VARCHAR(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
    number_type TEXT NOT NULL CHECK (number_type IN ('local', 'mobile', 'toll_free')),
    target_margin_pct NUMERIC(5, 2) NOT NULL DEFAULT 30.00 CHECK (target_margin_pct >= 0),
    minimum_fixed_margin_minor INT NOT NULL DEFAULT 100 CHECK (minimum_fixed_margin_minor >= 0),
    rounding_rule TEXT NOT NULL DEFAULT 'nearest_99' CHECK (rounding_rule IN ('none', 'nearest_99', 'round_up')),
    billing_currency VARCHAR(3) NOT NULL DEFAULT 'USD' CHECK (billing_currency ~ '^[A-Z]{3}$'),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for active pricing policy lookup
CREATE INDEX IF NOT EXISTS idx_pricing_policies_lookup 
ON public.phone_number_pricing_policies(provider, country_code, number_type, billing_currency) 
WHERE is_active = TRUE;

-- HARDENED: Partial UNIQUE Index enforcing at most ONE active policy per commercial scope
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_pricing_policy
ON public.phone_number_pricing_policies(provider, country_code, number_type, billing_currency)
WHERE is_active = TRUE;

-- Trigger for updated_at
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'update_phone_number_pricing_policies_updated_at'
    ) THEN
        CREATE TRIGGER update_phone_number_pricing_policies_updated_at
            BEFORE UPDATE ON public.phone_number_pricing_policies
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- Enable RLS on phone_number_pricing_policies
ALTER TABLE public.phone_number_pricing_policies ENABLE ROW LEVEL SECURITY;

-- Revoke direct table privileges from client roles
REVOKE ALL ON public.phone_number_pricing_policies FROM authenticated, anon;

-- Grant backend service-role full administrative management access
GRANT SELECT, INSERT, UPDATE, DELETE ON public.phone_number_pricing_policies TO service_role;

-- Service role full management RLS policy
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'Allow service_role full management on phone_number_pricing_policies'
    ) THEN
        CREATE POLICY "Allow service_role full management on phone_number_pricing_policies"
            ON public.phone_number_pricing_policies
            FOR ALL
            TO service_role
            USING (true)
            WITH CHECK (true);
    END IF;
END $$;


-- 3. Extend public.organization_compliance_profiles with Individual Given/Family Name
ALTER TABLE public.organization_compliance_profiles
ADD COLUMN IF NOT EXISTS given_name TEXT NULL,
ADD COLUMN IF NOT EXISTS family_name TEXT NULL;


-- 4. Initial Seed Data: Enable AU Local and US Local launch & pricing policies idempotently
INSERT INTO public.marketplace_launch_enablements (provider, country_code, number_type, is_enabled, notes)
VALUES
    ('twilio', 'AU', 'local', TRUE, 'Approved launch region: Australia Local'),
    ('twilio', 'US', 'local', TRUE, 'Approved launch region: United States Local')
ON CONFLICT (provider, country_code, number_type) 
DO UPDATE SET is_enabled = EXCLUDED.is_enabled, updated_at = NOW();

INSERT INTO public.phone_number_pricing_policies (provider, country_code, number_type, target_margin_pct, minimum_fixed_margin_minor, rounding_rule, billing_currency, is_active)
VALUES
    ('twilio', 'US', 'local', 30.00, 100, 'nearest_99', 'USD', TRUE),
    ('twilio', 'AU', 'local', 30.00, 150, 'nearest_99', 'USD', TRUE)
ON CONFLICT DO NOTHING;
