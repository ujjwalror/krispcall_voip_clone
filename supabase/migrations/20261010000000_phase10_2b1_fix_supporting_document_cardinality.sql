-- ====================================================================
-- MIGRATION: PHASE 10.2B.1 FIX SUPPORTING DOCUMENT CARDINALITY
-- Date: 2026-10-10
-- Establishes source_entity_id on provider_resource_mappings to distinguish
-- logical internal resources (e.g., multiple supporting documents, multiple item assignments)
-- while preserving strict single-cardinality for primary Address, End User, and Bundle.
-- DO NOT EXECUTE REMOTELY YET — Subject to manual review before Phase 10.2B.2.
-- ====================================================================

-- 1. Add source_entity_id column with safe 'primary' default for existing rows
ALTER TABLE public.provider_resource_mappings
ADD COLUMN IF NOT EXISTS source_entity_id TEXT NOT NULL DEFAULT 'primary';

-- 2. Drop the overly restrictive resource_type-only constraint
ALTER TABLE public.provider_resource_mappings
DROP CONSTRAINT IF EXISTS unique_org_profile_resource_type;

-- 3. Add explicit multi-cardinality logical resource constraint
-- Permits multiple distinct supporting documents (keyed by compliance_documents.id UUID) and multiple item assignments,
-- while strictly enforcing single-cardinality for primary Address, End User, and Bundle (keyed by 'primary_address', 'primary_end_user', 'primary_bundle').
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'unique_org_profile_resource_entity'
    ) THEN
        ALTER TABLE public.provider_resource_mappings
        ADD CONSTRAINT unique_org_profile_resource_entity
        UNIQUE (organization_id, compliance_profile_id, provider, resource_type, source_entity_id);
    END IF;
END $$;

-- 4. Preserve RLS and server-only permissions
ALTER TABLE public.provider_resource_mappings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.provider_resource_mappings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.provider_resource_mappings TO service_role;
