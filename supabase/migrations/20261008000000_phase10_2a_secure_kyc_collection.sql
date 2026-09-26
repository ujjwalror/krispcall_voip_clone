-- ====================================================================
-- MIGRATION: PHASE 10.2A SECURE KYC COLLECTION FOUNDATION
-- Date: 2026-10-08
-- Establishes encrypted field storage metadata, compliance documents schema,
-- private storage bucket declaration, and strict least-privilege security.
-- ====================================================================

-- 1. Extend public.compliance_field_values table for server-side AES-256-GCM encryption
ALTER TABLE public.compliance_field_values
ADD COLUMN IF NOT EXISTS is_encrypted BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS encryption_version VARCHAR(10) NULL,
ADD COLUMN IF NOT EXISTS iv TEXT NULL,
ADD COLUMN IF NOT EXISTS auth_tag TEXT NULL;

-- Revoke direct SELECT access to compliance_field_values from browser clients.
-- All reading/decryption passes exclusively through authorized server APIs using service_role authority.
REVOKE ALL ON public.compliance_field_values FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.compliance_field_values TO service_role;

-- 2. Create public.compliance_documents table
CREATE TABLE IF NOT EXISTS public.compliance_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    compliance_profile_id UUID NOT NULL REFERENCES public.organization_compliance_profiles(id) ON DELETE CASCADE,
    requirement_key TEXT NOT NULL,
    document_type TEXT NOT NULL,
    storage_object_path TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png')),
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880), -- 5MB limit
    sha256_hash VARCHAR(64) NOT NULL,
    status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'format_validated', 'rejected', 'deleted')),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for compliance documents
CREATE INDEX IF NOT EXISTS idx_compliance_docs_org_id 
ON public.compliance_documents(organization_id);

CREATE INDEX IF NOT EXISTS idx_compliance_docs_profile_id 
ON public.compliance_documents(compliance_profile_id);

-- Updated_at trigger for compliance_documents
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'update_compliance_documents_updated_at'
    ) THEN
        CREATE TRIGGER update_compliance_documents_updated_at
            BEFORE UPDATE ON public.compliance_documents
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- 3. Idempotent Private Supabase Storage Bucket Declaration
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'compliance-documents-private',
    'compliance-documents-private',
    false,
    5242880,
    ARRAY['application/pdf', 'image/jpeg', 'image/png']
)
ON CONFLICT (id) DO UPDATE SET
    public = false,
    file_size_limit = 5242880,
    allowed_mime_types = ARRAY['application/pdf', 'image/jpeg', 'image/png'];

-- 4. Enable Row Level Security (RLS) on compliance_documents
ALTER TABLE public.compliance_documents ENABLE ROW LEVEL SECURITY;

-- 5. Revoke least privilege table access from public/anon/authenticated roles.
-- Direct browser queries are forbidden. All metadata access passes through authorized server APIs using service_role authority.
REVOKE ALL ON public.compliance_documents FROM PUBLIC, anon, authenticated;

-- Grant FULL permissions to service_role (used exclusively by backend server APIs)
GRANT ALL ON public.compliance_documents TO service_role;
