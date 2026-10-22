-- ==============================================================================
-- PHASE 22C-3: TELECOM ACCOUNT PROVISIONING OPERATIONS (SAGA / IDEMPOTENCY)
-- LOCAL MIGRATION ONLY — DO NOT APPLY TO REMOTE PRODUCTION DATABASE DIRECTLY
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.telecom_account_provisioning_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('TWILIO', 'TELNYX', 'BANDWIDTH', 'AWS_CHIME', 'OTHER')),
    service_scope TEXT NOT NULL DEFAULT 'ALL' CHECK (service_scope IN ('ALL', 'VOICE', 'SMS', 'MMS', 'NUMBER_MANAGEMENT', 'RECORDING', 'COMPLIANCE')),
    idempotency_key TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(idempotency_key)) > 0 AND pg_catalog.length(idempotency_key) <= 128),
    status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (
        status IN (
            'REQUESTED',
            'PROVIDER_ACCOUNT_CREATED',
            'RUNTIME_CREDENTIAL_CREATED',
            'WEBHOOK_CREDENTIAL_CAPTURED',
            'SECRETS_STORED',
            'LOCAL_ACCOUNT_RECORDED',
            'ASSIGNMENT_CREATED',
            'READY',
            'FAILED',
            'REQUIRES_RECONCILIATION'
        )
    ),
    provider_account_reference TEXT NULL,
    runtime_credential_reference TEXT NULL,
    runtime_key_identifier TEXT NULL,
    webhook_credential_reference TEXT NULL,
    provider_account_id UUID NULL REFERENCES public.telecom_provider_accounts(id) ON DELETE SET NULL,
    assignment_id UUID NULL REFERENCES public.telecom_organization_provider_assignments(id) ON DELETE SET NULL,
    attempt_count INT NOT NULL DEFAULT 0,
    last_error_code TEXT NULL,
    last_error_message_sanitized TEXT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_telecom_account_prov_org_key UNIQUE (organization_id, provider, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_telecom_account_prov_ops_lookup
ON public.telecom_account_provisioning_operations(organization_id, provider, status);

CREATE INDEX IF NOT EXISTS idx_telecom_account_prov_ops_key
ON public.telecom_account_provisioning_operations(idempotency_key);

ALTER TABLE public.telecom_account_provisioning_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telecom_account_provisioning_operations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.telecom_account_provisioning_operations TO service_role;
