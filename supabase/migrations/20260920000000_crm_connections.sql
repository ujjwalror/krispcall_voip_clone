-- ====================================================================
-- PHASE CRM-1: PROVIDER-NEUTRAL CRM CONNECTIONS MIGRATION
-- Date: 2026-09-20
-- Table: public.crm_connections
-- Secure multi-tenant token storage with zero client-side access (RLS)
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.crm_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected', 'error', 'reauthorization_required')),
    external_account_id TEXT,
    external_org_name TEXT,
    external_user_email TEXT,
    api_domain TEXT NOT NULL DEFAULT 'https://www.zohoapis.com',
    accounts_domain TEXT NOT NULL DEFAULT 'https://accounts.zoho.com',
    scopes TEXT[] DEFAULT '{}',
    encrypted_access_token TEXT NOT NULL,
    encrypted_refresh_token TEXT NOT NULL,
    access_token_expires_at TIMESTAMPTZ NOT NULL,
    connected_by_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    connected_by_user_name TEXT,
    connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_refreshed_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_org_provider UNIQUE (organization_id, provider)
);

-- Index for organization and provider lookups
CREATE INDEX IF NOT EXISTS idx_crm_connections_org_provider ON public.crm_connections(organization_id, provider);

-- Trigger for auto-updating updated_at
CREATE TRIGGER update_crm_connections_updated_at
    BEFORE UPDATE ON public.crm_connections
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Enable Row Level Security (RLS)
ALTER TABLE public.crm_connections ENABLE ROW LEVEL SECURITY;

-- SECURITY NOTICE:
-- NO RLS POLICIES ARE CREATED FOR 'authenticated' OR 'anon' ROLES.
-- By default in PostgreSQL/Supabase, enabling RLS without SELECT/INSERT/UPDATE/DELETE
-- policies denies ALL client-side access from authenticated users and anonymous clients.
-- Access to credentials is strictly restricted to server-side code using Service Role (createAdminClient).
