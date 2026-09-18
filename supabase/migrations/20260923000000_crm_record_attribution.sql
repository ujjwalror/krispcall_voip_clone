-- ====================================================================
-- PHASE CRM-3: PROVIDER-NEUTRAL CRM RECORD ATTRIBUTION MIGRATION
-- Date: 2026-09-23
-- Table: public.crm_record_attribution_rules
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.crm_record_attribution_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    external_module TEXT NOT NULL CHECK (external_module IN ('Leads', 'Contacts')),
    attribute_key TEXT NOT NULL DEFAULT 'lead_source',
    external_field_key TEXT NOT NULL,
    configured_value TEXT NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT unique_org_provider_module_attr UNIQUE (organization_id, provider, external_module, attribute_key)
);

-- Performance Index
CREATE INDEX IF NOT EXISTS idx_crm_attribution_rules_org_provider ON public.crm_record_attribution_rules(organization_id, provider, external_module);

-- Auto-update updated_at trigger
CREATE TRIGGER update_crm_record_attribution_rules_updated_at
    BEFORE UPDATE ON public.crm_record_attribution_rules
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Row Level Security
ALTER TABLE public.crm_record_attribution_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view CRM attribution rules in their organization"
    ON public.crm_record_attribution_rules
    FOR SELECT
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles WHERE id = auth.uid()
        )
    );

-- Mutations performed strictly via server-side endpoints using Service Role / Admin Client
