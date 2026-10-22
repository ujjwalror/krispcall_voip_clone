-- ==============================================================================
-- PHASE 22C-R5.2B: TELECOM VAULT CREDENTIAL PURPOSE SCHEMA RECONCILIATION
-- ALIGNS PRODUCTION SCHEMA WITH CANONICAL CREDENTIAL PURPOSE ENUM
-- LOCAL MIGRATION ONLY — PREPARED BUT NOT EXECUTED IN R5.1 / R5.2B
-- ==============================================================================

-- 1. Ensure secret_type constraint enforces the authoritative 5-purpose closed enum
ALTER TABLE public.telecom_vault_secrets
  DROP CONSTRAINT IF EXISTS telecom_vault_secrets_secret_type_check;

ALTER TABLE public.telecom_vault_secrets
  ADD CONSTRAINT telecom_vault_secrets_secret_type_check
  CHECK (secret_type IN (
    'RUNTIME_API',
    'WEBHOOK_VERIFICATION',
    'WEBRTC_TOKEN_SIGNING',
    'ADMINISTRATIVE',
    'GENERAL'
  ));

-- 2. Create composite lookup index for high-performance tenant & purpose lookups
CREATE INDEX IF NOT EXISTS idx_telecom_vault_secrets_lookup
ON public.telecom_vault_secrets(provider_account_id, secret_type, status);

-- 3. Create status filtering index if not present
CREATE INDEX IF NOT EXISTS idx_telecom_vault_secrets_status
ON public.telecom_vault_secrets(status);

-- 4. Document canonical purpose semantics on table and constraint
COMMENT ON CONSTRAINT telecom_vault_secrets_secret_type_check ON public.telecom_vault_secrets IS
'Enforces distinct cryptographic credential purposes including native WEBRTC_TOKEN_SIGNING separation.';

COMMENT ON COLUMN public.telecom_vault_secrets.secret_type IS
'Canonical purpose discriminator: RUNTIME_API, WEBHOOK_VERIFICATION, WEBRTC_TOKEN_SIGNING, ADMINISTRATIVE, GENERAL.';
