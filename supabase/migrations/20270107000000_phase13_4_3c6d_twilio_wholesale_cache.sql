-- ============================================================================
-- PHASE 13.4.3C STAGE C.6D.2: TWILIO VOICE WHOLESALE PRICING FOUNDATION
-- Isolated Forward-Only Migration
-- DO NOT APPLY REMOTELY AUTOMATICALLY — USER MANDATED MANUAL SQL REVIEW
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Create provider_voice_pricing_cache Table
-- Durable internal provider wholesale pricing cache for voice usage
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.provider_voice_pricing_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_account_id TEXT NOT NULL DEFAULT 'default',
    provider_key TEXT NOT NULL DEFAULT 'twilio',
    service_type TEXT NOT NULL CHECK (service_type IN ('voice_outbound', 'voice_inbound')),
    direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
    iso_country VARCHAR(2) NOT NULL,
    destination_prefix TEXT NOT NULL DEFAULT '*',
    origination_prefix TEXT DEFAULT '*',
    number_type TEXT CHECK (number_type IS NULL OR number_type IN ('local', 'mobile', 'national', 'toll_free', 'any')),
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    current_price_micro BIGINT NOT NULL CHECK (current_price_micro >= 0),
    base_price_micro BIGINT CHECK (base_price_micro IS NULL OR base_price_micro >= 0),
    price_unit TEXT NOT NULL DEFAULT 'minute',
    billing_increment_seconds INTEGER NOT NULL DEFAULT 60 CHECK (billing_increment_seconds > 0),
    min_chargeable_units INTEGER NOT NULL DEFAULT 1 CHECK (min_chargeable_units > 0),
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    soft_stale_at TIMESTAMPTZ NOT NULL,
    hard_expires_at TIMESTAMPTZ NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    source_api_version TEXT NOT NULL DEFAULT 'v2',
    pricing_fingerprint TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Comments for Schema Governance
COMMENT ON TABLE public.provider_voice_pricing_cache IS 'Stage C.6D: Confidential durable provider wholesale voice pricing cache. Strictly service_role internal.';
COMMENT ON COLUMN public.provider_voice_pricing_cache.current_price_micro IS 'Authoritative wholesale pre-call provider cost in sub-cent micro-units.';
COMMENT ON COLUMN public.provider_voice_pricing_cache.base_price_micro IS 'Informational list price in sub-cent micro-units for audit only.';

-- Unique partial index for versioned active record resolution
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_voice_pricing_cache_active_key 
ON public.provider_voice_pricing_cache (
    provider_account_id,
    provider_key,
    service_type,
    direction,
    iso_country,
    destination_prefix,
    COALESCE(origination_prefix, '*'),
    COALESCE(number_type, 'any')
) WHERE is_active = true;

-- Index for lookup and expiration queries
CREATE INDEX IF NOT EXISTS idx_provider_voice_pricing_cache_lookup 
ON public.provider_voice_pricing_cache (service_type, direction, iso_country, is_active);

CREATE INDEX IF NOT EXISTS idx_provider_voice_pricing_cache_expiry 
ON public.provider_voice_pricing_cache (hard_expires_at) WHERE is_active = true;

-- Strict Row Level Security (RLS) & Access Privilege Isolation
ALTER TABLE public.provider_voice_pricing_cache ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.provider_voice_pricing_cache FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.provider_voice_pricing_cache TO service_role;


-- ----------------------------------------------------------------------------
-- 2. Create provider_voice_price_sync_runs Table
-- Internal audit trail for provider wholesale price synchronization runs
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.provider_voice_price_sync_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_account_id TEXT NOT NULL DEFAULT 'default',
    provider_key TEXT NOT NULL DEFAULT 'twilio',
    iso_country VARCHAR(2) NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'partial')),
    records_observed INTEGER NOT NULL DEFAULT 0 CHECK (records_observed >= 0),
    records_inserted INTEGER NOT NULL DEFAULT 0 CHECK (records_inserted >= 0),
    records_updated INTEGER NOT NULL DEFAULT 0 CHECK (records_updated >= 0),
    records_versioned INTEGER NOT NULL DEFAULT 0 CHECK (records_versioned >= 0),
    error_classification TEXT,
    sanitized_diagnostics JSONB DEFAULT '{}'::jsonb,
    fingerprint TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Comments for Schema Governance
COMMENT ON TABLE public.provider_voice_price_sync_runs IS 'Stage C.6D: Audit log of wholesale pricing synchronization jobs. Service_role internal only.';

-- Index for sync history lookup
CREATE INDEX IF NOT EXISTS idx_provider_voice_price_sync_runs_lookup 
ON public.provider_voice_price_sync_runs (provider_account_id, provider_key, iso_country, started_at DESC);

-- Strict Row Level Security (RLS) & Access Privilege Isolation
ALTER TABLE public.provider_voice_price_sync_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.provider_voice_price_sync_runs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.provider_voice_price_sync_runs TO service_role;
