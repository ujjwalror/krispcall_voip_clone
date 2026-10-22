-- ============================================================================
-- PHASE 20.1C: TELECOM FRAUD, DESTINATION AND ABUSE CONTROL FOUNDATION
-- LOCAL PREPARATION ONLY - DO NOT APPLY REMOTELY
--
-- Objective:
-- 1. Adds layered suspension kill switches for profiles, phone_numbers,
--    and organization_billing_controls.
-- 2. Adds geographic destination permission controls to organization_billing_controls.
-- 3. Creates provider-neutral messaging consent & opt-out suppression store.
-- 4. Creates telecom security events audit log table.
-- ============================================================================

-- 1. Layered User Telecom Suspension Kill Switch
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS telecom_suspended BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.telecom_suspended IS
'Administrative safety kill switch to restrict telecom voice/SMS capabilities for compromised user sessions.';

-- 2. Layered Business Number Telecom Suspension Kill Switch
ALTER TABLE public.phone_numbers
ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.phone_numbers.is_suspended IS
'Administrative safety kill switch to freeze telecom voice/SMS operations on an abused carrier number.';

-- 3. Layered Organization Telecom Suspension & Geographic Risk Controls
ALTER TABLE public.organization_billing_controls
ADD COLUMN IF NOT EXISTS telecom_suspended BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.organization_billing_controls
ADD COLUMN IF NOT EXISTS allowed_destination_countries TEXT[] NULL;

ALTER TABLE public.organization_billing_controls
ADD COLUMN IF NOT EXISTS blocked_destination_countries TEXT[] NULL;

ALTER TABLE public.organization_billing_controls
ADD COLUMN IF NOT EXISTS voice_risk_ceiling_seconds JSONB NULL;

COMMENT ON COLUMN public.organization_billing_controls.telecom_suspended IS
'Administrative safety kill switch to freeze all outbound telecom operations across an entire organization without affecting unrelated organizations.';

COMMENT ON COLUMN public.organization_billing_controls.allowed_destination_countries IS
'Whitelisted ISO 2-letter country codes permitted for outbound voice and messaging.';

COMMENT ON COLUMN public.organization_billing_controls.blocked_destination_countries IS
'Blacklisted ISO 2-letter country codes prohibited from outbound voice and messaging.';

-- 4. Telecom Messaging Consent & Opt-Out Suppression Store
CREATE TABLE IF NOT EXISTS public.telecom_messaging_consents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    phone_number TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'opted_out' CHECK (status IN ('opted_out', 'opted_in', 'unspecified')),
    opt_out_keyword TEXT NULL,
    opted_out_at TIMESTAMPTZ NULL,
    opted_in_at TIMESTAMPTZ NULL,
    metadata JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
    CONSTRAINT uq_telecom_messaging_consents_org_phone UNIQUE (organization_id, phone_number)
);

CREATE INDEX IF NOT EXISTS idx_telecom_messaging_consents_lookup
ON public.telecom_messaging_consents(organization_id, phone_number, status);

COMMENT ON TABLE public.telecom_messaging_consents IS
'Provider-neutral recipient messaging consent and opt-out suppression store. Prevents sending outbound SMS/MMS to opted-out recipients.';

-- 5. Telecom Security Audit Log Table
CREATE TABLE IF NOT EXISTS public.telecom_security_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    user_id UUID NULL,
    phone_number TEXT NULL,
    destination TEXT NULL,
    risk_rule TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('voice_dial', 'call_transfer', 'call_hold', 'sms_send', 'mms_send', 'recording_access', 'provider_mutation')),
    decision TEXT NOT NULL CHECK (decision IN ('blocked', 'restricted', 'throttled', 'allowed')),
    reason TEXT NOT NULL,
    metadata JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS idx_telecom_security_events_org_created
ON public.telecom_security_events(organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telecom_security_events_rule
ON public.telecom_security_events(risk_rule, created_at DESC);

COMMENT ON TABLE public.telecom_security_events IS
'Structured, sanitized telecom security audit event log for fraud, abuse, velocity, and tenant-boundary violations.';
