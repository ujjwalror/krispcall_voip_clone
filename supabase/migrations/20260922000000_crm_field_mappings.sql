-- ====================================================================
-- PHASE CRM-3: PROVIDER-NEUTRAL FIELD MAPPINGS & METADATA CACHE MIGRATION
-- Date: 2026-09-22
-- Tables: public.crm_field_mappings, public.crm_field_metadata_cache
-- ====================================================================

-- 1. Field Mappings Table
CREATE TABLE IF NOT EXISTS public.crm_field_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    external_module TEXT NOT NULL CHECK (external_module IN ('Leads', 'Contacts')),
    local_field_key TEXT NOT NULL,
    external_field_key TEXT NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT unique_org_provider_module_local UNIQUE (organization_id, provider, external_module, local_field_key),
    CONSTRAINT unique_org_provider_module_external UNIQUE (organization_id, provider, external_module, external_field_key)
);

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_crm_field_mappings_org_provider ON public.crm_field_mappings(organization_id, provider, external_module);

-- Trigger for auto-updating updated_at
CREATE TRIGGER update_crm_field_mappings_updated_at
    BEFORE UPDATE ON public.crm_field_mappings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Enable RLS
ALTER TABLE public.crm_field_mappings ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to view field mappings belonging to their organization
CREATE POLICY "Users can view CRM field mappings in their organization"
    ON public.crm_field_mappings
    FOR SELECT
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles WHERE id = auth.uid()
        )
    );

-- 2. Metadata Cache Table (Persistent Supabase Snapshots)
CREATE TABLE IF NOT EXISTS public.crm_field_metadata_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    external_module TEXT NOT NULL CHECK (external_module IN ('Leads', 'Contacts')),
    fields_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT unique_org_provider_module_cache UNIQUE (organization_id, provider, external_module)
);

CREATE INDEX IF NOT EXISTS idx_crm_metadata_cache_org_provider ON public.crm_field_metadata_cache(organization_id, provider, external_module);

CREATE TRIGGER update_crm_field_metadata_cache_updated_at
    BEFORE UPDATE ON public.crm_field_metadata_cache
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.crm_field_metadata_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view CRM field metadata cache in their organization"
    ON public.crm_field_metadata_cache
    FOR SELECT
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles WHERE id = auth.uid()
        )
    );

-- Mutations are performed strictly via server-side endpoints using Service Role / Admin Client
