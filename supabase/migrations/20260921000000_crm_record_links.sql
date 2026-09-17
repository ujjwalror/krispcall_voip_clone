-- ====================================================================
-- PHASE CRM-2: PROVIDER-NEUTRAL CRM RECORD LINKS MIGRATION
-- Date: 2026-09-21
-- Table: public.crm_record_links
-- Links local saved VoIP Hub contacts (public.contacts) to external CRM records (e.g. Zoho Leads/Contacts)
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.crm_record_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    external_module TEXT NOT NULL CHECK (external_module IN ('Leads', 'Contacts')),
    external_record_id TEXT NOT NULL,
    external_display_name TEXT,
    external_email TEXT,
    external_phone TEXT,
    created_by_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Prevent a local contact from having multiple active links to the same provider
    CONSTRAINT unique_org_provider_contact UNIQUE (organization_id, provider, contact_id),

    -- Prevent two local contacts from linking to the exact same external CRM record
    CONSTRAINT unique_org_provider_external_record UNIQUE (organization_id, provider, external_module, external_record_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_crm_record_links_org_provider ON public.crm_record_links(organization_id, provider);
CREATE INDEX IF NOT EXISTS idx_crm_record_links_contact ON public.crm_record_links(organization_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_record_links_external ON public.crm_record_links(organization_id, provider, external_module, external_record_id);

-- Trigger for auto-updating updated_at
CREATE TRIGGER update_crm_record_links_updated_at
    BEFORE UPDATE ON public.crm_record_links
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Enable Row Level Security (RLS)
ALTER TABLE public.crm_record_links ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to view links belonging to their organization
CREATE POLICY "Users can view CRM links in their organization"
    ON public.crm_record_links
    FOR SELECT
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles WHERE id = auth.uid()
        )
    );

-- Mutations are performed strictly via server-side endpoints using Service Role / Admin Client
