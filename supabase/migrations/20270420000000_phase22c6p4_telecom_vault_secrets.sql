-- ==============================================================================
-- PHASE 22C-6P.4A: INDUSTRIAL KMS-BACKED ENVELOPE VAULT SECRETS STORE
-- LOCAL MIGRATION ONLY — DO NOT APPLY TO REMOTE PRODUCTION DATABASE DIRECTLY
-- ==============================================================================

-- 1. Create telecom_vault_secrets table for two-tier envelope encrypted secrets
CREATE TABLE IF NOT EXISTS public.telecom_vault_secrets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_account_id UUID NOT NULL REFERENCES public.telecom_provider_accounts(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL,
    credential_purpose TEXT NOT NULL CHECK (credential_purpose IN ('RUNTIME_API', 'WEBHOOK_VERIFICATION', 'ADMINISTRATIVE', 'GENERAL')),
    reference_id TEXT NOT NULL UNIQUE,
    key_identifier TEXT NULL,
    account_reference TEXT NULL,
    encrypted_payload BYTEA NOT NULL,
    nonce BYTEA NOT NULL,
    auth_tag BYTEA NOT NULL,
    wrapped_dek BYTEA NOT NULL,
    kek_identifier TEXT NOT NULL,
    kek_version TEXT NULL,
    secret_version INT NOT NULL DEFAULT 1 CHECK (secret_version > 0),
    algorithm TEXT NOT NULL DEFAULT 'AES-256-GCM' CHECK (algorithm IN ('AES-256-GCM')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'previous', 'revoked', 'deleted')),
    environment TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'development', 'staging', 'sandbox')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
    rotated_at TIMESTAMPTZ NULL,
    revoked_at TIMESTAMPTZ NULL,
    expires_at TIMESTAMPTZ NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- 2. Indexes for fast lookup by reference and tenant provider account
CREATE INDEX IF NOT EXISTS idx_telecom_vault_secrets_ref
ON public.telecom_vault_secrets(reference_id);

CREATE INDEX IF NOT EXISTS idx_telecom_vault_secrets_lookup
ON public.telecom_vault_secrets(provider_account_id, credential_purpose, status);

CREATE INDEX IF NOT EXISTS idx_telecom_vault_secrets_status
ON public.telecom_vault_secrets(status);

COMMENT ON TABLE public.telecom_vault_secrets IS
'Authoritative envelope-encrypted secret store for telecom provider credentials. No plaintext secrets or DEKs are ever stored in the database.';

-- 3. Row-Level Security & Strict Access Boundaries
ALTER TABLE public.telecom_vault_secrets ENABLE ROW LEVEL SECURITY;

-- 4. Inaccessible to public, anon, and authenticated users
REVOKE ALL ON public.telecom_vault_secrets FROM PUBLIC;
REVOKE ALL ON public.telecom_vault_secrets FROM anon;
REVOKE ALL ON public.telecom_vault_secrets FROM authenticated;

-- 5. Narrowly grant server-side service_role access only
GRANT SELECT, INSERT, UPDATE, DELETE ON public.telecom_vault_secrets TO service_role;
