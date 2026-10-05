-- ============================================================================
-- REGULATORY METADATA CACHE LAYER FOUNDATION
-- Isolated Forward-Only Migration
-- DO NOT APPLY REMOTELY AUTOMATICALLY — USER MANDATED MANUAL SQL REVIEW
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Create public.regulatory_metadata_cache Table
-- Durable provider-neutral regulatory requirement metadata cache
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.regulatory_metadata_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL DEFAULT 'twilio',
    provider_account_id TEXT NOT NULL DEFAULT 'default',
    country_code VARCHAR(2) NOT NULL,
    number_type TEXT NOT NULL CHECK (number_type IN ('local', 'mobile', 'toll_free', 'national')),
    end_user_type TEXT NOT NULL CHECK (end_user_type IN ('business', 'individual')),
    status TEXT NOT NULL CHECK (status IN ('no_additional_requirements', 'requirements_found', 'unavailable')),
    regulation_id TEXT,
    address_requirement TEXT,
    end_user_requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
    supporting_document_requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
    bundle_required BOOLEAN NOT NULL DEFAULT false,
    message TEXT,
    provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    fingerprint TEXT NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    refresh_lock_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Comments for Schema Governance
COMMENT ON TABLE public.regulatory_metadata_cache IS 'Provider-neutral regulatory requirement metadata cache for public-SaaS browsing acceleration. Service-role internal write access.';
COMMENT ON COLUMN public.regulatory_metadata_cache.fingerprint IS 'Deterministic SHA-256 hash of canonicalized normalized regulatory requirements payload for change detection.';
COMMENT ON COLUMN public.regulatory_metadata_cache.refresh_lock_until IS 'Single-flight lease timestamp to prevent concurrent cache stampedes on miss/expired entries.';

-- Unique index for exact provider/account/country/type resolution
CREATE UNIQUE INDEX IF NOT EXISTS idx_regulatory_metadata_cache_key 
ON public.regulatory_metadata_cache (
    provider,
    provider_account_id,
    country_code,
    number_type,
    end_user_type
);

-- Index for lookup and expiration queries
CREATE INDEX IF NOT EXISTS idx_regulatory_metadata_cache_lookup 
ON public.regulatory_metadata_cache (
    provider,
    provider_account_id,
    country_code,
    number_type,
    end_user_type,
    expires_at
);

-- Strict Row Level Security (RLS) & Access Privilege Isolation
ALTER TABLE public.regulatory_metadata_cache ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.regulatory_metadata_cache FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.regulatory_metadata_cache TO service_role;
