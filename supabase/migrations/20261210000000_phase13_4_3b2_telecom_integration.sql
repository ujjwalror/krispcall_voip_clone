-- ============================================================================
-- PUBLIC SAAS PHASE 13.4.3B.2A — TELECOM USAGE DOMAIN & SCHEMA FOUNDATION
-- Date: 2026-12-10
-- Creates public.telecom_usage_sessions, public.telecom_usage_components,
-- public.telecom_provider_operations, and public.telecom_provider_event_log.
-- Enforces HARD DATABASE-LEVEL CROSS-TENANT ISOLATION using composite multi-column
-- foreign keys (organization_id, session_id), (organization_id, component_id),
-- and (organization_id, internal_usage_id) with strict ON DELETE RESTRICT rules.
-- Removes redundant reservation_id from components to guarantee single canonical reservation identity.
-- Configures strict server-only (service_role only) RLS and privileges,
-- non-destructive ON DELETE RESTRICT rules preserving financial audit integrity,
-- and explicit PostgreSQL partial unique indexes for event deduplication.
-- ============================================================================

BEGIN;

-- 1. Additive Compatibility Candidate Key on Frozen B.1 telecom_usage_reservations
-- Enables composite foreign keys from B.2A without modifying frozen B.1 table structure
CREATE UNIQUE INDEX IF NOT EXISTS uq_telecom_usage_reservations_org_usage
ON public.telecom_usage_reservations(organization_id, internal_usage_id);

-- 2. Create public.telecom_usage_sessions table (One Customer-Understandable Interaction)
CREATE TABLE IF NOT EXISTS public.telecom_usage_sessions (
    session_id TEXT PRIMARY KEY CHECK (pg_catalog.length(pg_catalog.btrim(session_id)) > 0 AND pg_catalog.length(session_id) <= 128 AND session_id ~ '^[a-zA-Z0-9_\-]+$'),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    created_by_user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    session_type TEXT NOT NULL CHECK (session_type IN ('outbound_call', 'inbound_call', 'sms', 'mms', 'other')),
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed', 'reconciliation_required')),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
    total_retail_charge_minor BIGINT NOT NULL DEFAULT 0 CHECK (total_retail_charge_minor >= 0),
    total_wholesale_cost_minor BIGINT NOT NULL DEFAULT 0 CHECK (total_wholesale_cost_minor >= 0),
    reconciliation_status TEXT NOT NULL DEFAULT 'pending' CHECK (reconciliation_status IN ('pending', 'reconciled', 'manual_review')),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT uq_telecom_usage_sessions_org_session UNIQUE (organization_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_telecom_usage_sessions_org_status
ON public.telecom_usage_sessions(organization_id, status);

CREATE INDEX IF NOT EXISTS idx_telecom_usage_sessions_type_created
ON public.telecom_usage_sessions(organization_id, session_type, created_at DESC);

-- Trigger for updated_at on telecom_usage_sessions
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_telecom_usage_sessions_updated_at'
    ) THEN
        CREATE TRIGGER trg_telecom_usage_sessions_updated_at
            BEFORE UPDATE ON public.telecom_usage_sessions
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- 3. Create public.telecom_usage_components table (Provider / Billable Leg Components)
CREATE TABLE IF NOT EXISTS public.telecom_usage_components (
    component_id TEXT PRIMARY KEY CHECK (pg_catalog.length(pg_catalog.btrim(component_id)) > 0 AND pg_catalog.length(component_id) <= 128 AND component_id ~ '^[a-zA-Z0-9_\-]+$'),
    session_id TEXT NOT NULL,
    organization_id UUID NOT NULL,
    internal_usage_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'twilio' CHECK (pg_catalog.length(pg_catalog.btrim(provider)) > 0 AND provider ~ '^[a-zA-Z0-9_\-]+$'),
    provider_account_id TEXT NULL,
    parent_provider_resource_id TEXT NULL, -- Parent CallSid
    child_provider_resource_id TEXT NULL,  -- Child CallSid or MessageSid
    leg_type TEXT NOT NULL CHECK (leg_type IN ('pstn_outbound', 'pstn_inbound', 'client_leg', 'sms_segment', 'mms_media', 'forwarding', 'transfer', 'conference', 'other')),
    sequence_number INT NOT NULL DEFAULT 0 CHECK (sequence_number >= 0),
    duration_seconds INT NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
    retail_charge_minor BIGINT NOT NULL DEFAULT 0 CHECK (retail_charge_minor >= 0),
    provider_wholesale_cost_minor BIGINT NULL CHECK (provider_wholesale_cost_minor IS NULL OR provider_wholesale_cost_minor >= 0),
    reconciliation_status TEXT NOT NULL DEFAULT 'pending' CHECK (reconciliation_status IN ('pending', 'reconciled', 'manual_review')),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    -- DATABASE-ENFORCED CROSS-TENANT ISOLATION
    CONSTRAINT fk_telecom_usage_components_session_org FOREIGN KEY (organization_id, session_id) REFERENCES public.telecom_usage_sessions(organization_id, session_id) ON DELETE RESTRICT,
    CONSTRAINT fk_telecom_usage_components_reservation_org FOREIGN KEY (organization_id, internal_usage_id) REFERENCES public.telecom_usage_reservations(organization_id, internal_usage_id) ON DELETE RESTRICT,
    CONSTRAINT uq_telecom_usage_components_org_component UNIQUE (organization_id, component_id)
);

CREATE INDEX IF NOT EXISTS idx_telecom_usage_components_session
ON public.telecom_usage_components(organization_id, session_id);

CREATE INDEX IF NOT EXISTS idx_telecom_usage_components_org_internal
ON public.telecom_usage_components(organization_id, internal_usage_id);

CREATE INDEX IF NOT EXISTS idx_telecom_usage_components_provider_res
ON public.telecom_usage_components(provider, child_provider_resource_id)
WHERE child_provider_resource_id IS NOT NULL;

-- Trigger for updated_at on telecom_usage_components
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_telecom_usage_components_updated_at'
    ) THEN
        CREATE TRIGGER trg_telecom_usage_components_updated_at
            BEFORE UPDATE ON public.telecom_usage_components
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- 4. Create public.telecom_provider_operations table (Durable Authority for Provider Mutations)
CREATE TABLE IF NOT EXISTS public.telecom_provider_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    session_id TEXT NULL,
    component_id TEXT NULL,
    internal_usage_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'twilio' CHECK (pg_catalog.length(pg_catalog.btrim(provider)) > 0 AND provider ~ '^[a-zA-Z0-9_\-]+$'),
    operation_type TEXT NOT NULL CHECK (operation_type IN ('message_create', 'call_duration_update', 'call_terminate', 'other')),
    idempotency_key TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(idempotency_key)) > 0 AND pg_catalog.length(idempotency_key) <= 128 AND idempotency_key ~ '^[a-zA-Z0-9_\-]+$'),
    request_fingerprint TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(request_fingerprint)) > 0),
    provider_resource_id TEXT NULL,
    status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'dispatch_claimed', 'provider_id_known', 'reconciliation_required', 'confirmed_created', 'confirmed_absent', 'failed')),
    reconciliation_status TEXT NOT NULL DEFAULT 'none' CHECK (reconciliation_status IN ('none', 'pending', 'reconciled', 'manual_review')),
    attempt_count INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    dispatch_token TEXT NULL,
    last_error JSONB NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    -- DATABASE-ENFORCED CROSS-TENANT ISOLATION (STRICT AUDIT PRESERVATION)
    CONSTRAINT fk_telecom_provider_ops_session_org FOREIGN KEY (organization_id, session_id) REFERENCES public.telecom_usage_sessions(organization_id, session_id) ON DELETE RESTRICT,
    CONSTRAINT fk_telecom_provider_ops_component_org FOREIGN KEY (organization_id, component_id) REFERENCES public.telecom_usage_components(organization_id, component_id) ON DELETE RESTRICT,
    CONSTRAINT fk_telecom_provider_ops_reservation_org FOREIGN KEY (organization_id, internal_usage_id) REFERENCES public.telecom_usage_reservations(organization_id, internal_usage_id) ON DELETE RESTRICT,
    CONSTRAINT uq_telecom_provider_op_key UNIQUE (organization_id, operation_type, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_telecom_provider_ops_org_status
ON public.telecom_provider_operations(organization_id, status);

CREATE INDEX IF NOT EXISTS idx_telecom_provider_ops_res_id
ON public.telecom_provider_operations(provider, provider_resource_id)
WHERE provider_resource_id IS NOT NULL;

-- Trigger for updated_at on telecom_provider_operations
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_telecom_provider_operations_updated_at'
    ) THEN
        CREATE TRIGGER trg_telecom_provider_operations_updated_at
            BEFORE UPDATE ON public.telecom_provider_operations
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- 5. Create public.telecom_provider_event_log table (Durable Event & Callback Deduplication)
CREATE TABLE IF NOT EXISTS public.telecom_provider_event_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE SET NULL,
    provider TEXT NOT NULL DEFAULT 'twilio' CHECK (pg_catalog.length(pg_catalog.btrim(provider)) > 0 AND provider ~ '^[a-zA-Z0-9_\-]+$'),
    event_id TEXT NULL, -- e.g. I-Twilio-Idempotency-Token or Webhook EventSid
    provider_resource_id TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(provider_resource_id)) > 0),
    event_type TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(event_type)) > 0),
    sequence_number INT NULL CHECK (sequence_number IS NULL OR sequence_number >= 0),
    payload_fingerprint TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(payload_fingerprint)) > 0),
    payload JSONB NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    processed_at TIMESTAMPTZ NULL,
    processing_result TEXT NOT NULL DEFAULT 'processed' CHECK (processing_result IN ('processed', 'duplicate_ignored', 'out_of_order_ignored', 'error')),
    error_details TEXT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- PostgreSQL Partial Unique Indexes to prevent NULL sequence_number or NULL event_id bypass!
CREATE UNIQUE INDEX IF NOT EXISTS uq_telecom_provider_event_by_event_id
ON public.telecom_provider_event_log(provider, provider_resource_id, event_type, event_id)
WHERE event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_telecom_provider_event_by_sequence
ON public.telecom_provider_event_log(provider, provider_resource_id, event_type, sequence_number)
WHERE sequence_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_telecom_provider_event_by_fingerprint
ON public.telecom_provider_event_log(provider, provider_resource_id, event_type, payload_fingerprint)
WHERE event_id IS NULL AND sequence_number IS NULL;

-- 6. SERVER-ONLY CONFIDENTIALITY & PRIVILEGES (SERVICE ROLE ONLY DIRECT ACCESS)
ALTER TABLE public.telecom_usage_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telecom_usage_sessions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.telecom_usage_sessions TO service_role;

ALTER TABLE public.telecom_usage_components ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telecom_usage_components FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.telecom_usage_components TO service_role;

ALTER TABLE public.telecom_provider_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telecom_provider_operations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.telecom_provider_operations TO service_role;

ALTER TABLE public.telecom_provider_event_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telecom_provider_event_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.telecom_provider_event_log TO service_role;

COMMIT;
