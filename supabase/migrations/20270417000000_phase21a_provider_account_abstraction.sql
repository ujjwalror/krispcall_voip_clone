-- ==============================================================================
-- PHASE 21A: PROVIDER-NEUTRAL TELECOM ACCOUNT ABSTRACTION FOUNDATION
-- LOCAL MIGRATION ONLY — DO NOT APPLY TO REMOTE PRODUCTION DATABASE DIRECTLY
-- ==============================================================================

-- 1. Create telecom_provider_accounts table
CREATE TABLE IF NOT EXISTS public.telecom_provider_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL,
    account_type TEXT NOT NULL CHECK (account_type IN ('SHARED_PARENT', 'CUSTOMER_SUBACCOUNT', 'DEDICATED_ACCOUNT', 'OTHER')),
    account_reference TEXT NOT NULL UNIQUE,
    credential_reference TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deprovisioned', 'maintenance')),
    capabilities TEXT[] NOT NULL DEFAULT ARRAY['VOICE', 'SMS', 'MMS', 'NUMBER_MANAGEMENT', 'RECORDING', 'COMPLIANCE'],
    environment TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'development', 'staging', 'sandbox')),
    parent_provider_account_id UUID REFERENCES public.telecom_provider_accounts(id) ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telecom_provider_accounts_lookup 
ON public.telecom_provider_accounts(provider, account_type, status);

CREATE INDEX IF NOT EXISTS idx_telecom_provider_accounts_ref 
ON public.telecom_provider_accounts(account_reference);

-- 2. Create telecom_organization_provider_assignments table
CREATE TABLE IF NOT EXISTS public.telecom_organization_provider_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    provider_account_id UUID NOT NULL REFERENCES public.telecom_provider_accounts(id) ON DELETE RESTRICT,
    service_scope TEXT NOT NULL CHECK (service_scope IN ('ALL', 'VOICE', 'SMS', 'MMS', 'NUMBER_MANAGEMENT', 'RECORDING', 'COMPLIANCE')),
    country_code VARCHAR(2) NULL,
    priority INT NOT NULL DEFAULT 100,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telecom_org_provider_assign 
ON public.telecom_organization_provider_assignments(organization_id, service_scope, is_active, priority DESC);

CREATE INDEX IF NOT EXISTS idx_telecom_org_provider_assign_country 
ON public.telecom_organization_provider_assignments(organization_id, country_code);

-- 3. Create telecom_provider_resource_records table
CREATE TABLE IF NOT EXISTS public.telecom_provider_resource_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    provider_account_id UUID NOT NULL REFERENCES public.telecom_provider_accounts(id) ON DELETE RESTRICT,
    resource_type TEXT NOT NULL CHECK (resource_type IN ('PHONE_NUMBER', 'CALL', 'MESSAGE', 'RECORDING', 'COMPLIANCE_RESOURCE')),
    local_resource_id TEXT NOT NULL,
    remote_resource_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'TWILIO',
    status TEXT NOT NULL DEFAULT 'active',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_org_provider_remote_resource UNIQUE (organization_id, provider_account_id, resource_type, remote_resource_id)
);

CREATE INDEX IF NOT EXISTS idx_telecom_provider_resources_lookup 
ON public.telecom_provider_resource_records(organization_id, resource_type, local_resource_id);

CREATE INDEX IF NOT EXISTS idx_telecom_provider_resources_remote 
ON public.telecom_provider_resource_records(remote_resource_id);

-- 4. Seed the Logical Shared Parent Twilio Account
INSERT INTO public.telecom_provider_accounts (
    id,
    provider,
    account_type,
    account_reference,
    credential_reference,
    status,
    capabilities,
    environment,
    metadata
) VALUES (
    '00000000-0000-0000-0000-000000000001',
    'TWILIO',
    'SHARED_PARENT',
    'shared_parent_twilio',
    'env:TWILIO_ACCOUNT_SID',
    'active',
    ARRAY['VOICE', 'SMS', 'MMS', 'NUMBER_MANAGEMENT', 'RECORDING', 'COMPLIANCE'],
    'production',
    '{"description": "Shared primary Twilio parent account for standard multi-tenant operations"}'::jsonb
) ON CONFLICT (account_reference) DO NOTHING;

-- 5. Enable Row-Level Security
ALTER TABLE public.telecom_provider_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telecom_organization_provider_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telecom_provider_resource_records ENABLE ROW LEVEL SECURITY;

-- 6. Access Control: Revoke all from anon/authenticated, grant to service_role
REVOKE ALL ON public.telecom_provider_accounts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.telecom_organization_provider_assignments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.telecom_provider_resource_records FROM PUBLIC, anon, authenticated;

GRANT ALL ON public.telecom_provider_accounts TO service_role;
GRANT ALL ON public.telecom_organization_provider_assignments TO service_role;
GRANT ALL ON public.telecom_provider_resource_records TO service_role;
