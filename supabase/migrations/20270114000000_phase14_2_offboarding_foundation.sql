-- ====================================================================
-- MIGRATION: PHASE 14.2 SAAS CANCELLATION & OFFBOARDING FOUNDATION
-- Date: 2027-01-14
-- Establishes durable public.number_lifecycle_policies,
-- public.phone_number_lifecycle_states, and public.number_lifecycle_notifications.
-- Provides data model for SaaS cancellation, retention grace periods,
-- suspension, financial-loss prevention, and idempotent notifications.
-- LOCAL MIGRATION ONLY — DO NOT EXECUTE REMOTELY AUTOMATICALLY.
-- ====================================================================

-- 1. Create public.number_lifecycle_policies table
CREATE TABLE IF NOT EXISTS public.number_lifecycle_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    policy_name TEXT NOT NULL,
    advance_cancellation_notice_days INT NULL,
    past_due_retention_days INT NULL,
    suspension_threshold_days INT NULL,
    release_pending_duration_days INT NULL,
    final_release_eligibility_days INT NULL,
    allow_number_only_retention BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for organization policy resolution
CREATE INDEX IF NOT EXISTS idx_number_lifecycle_policies_org ON public.number_lifecycle_policies(organization_id);

-- 2. Create public.phone_number_lifecycle_states table
CREATE TABLE IF NOT EXISTS public.phone_number_lifecycle_states (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    phone_number_id UUID NOT NULL REFERENCES public.phone_numbers(id) ON DELETE RESTRICT,
    phone_number_e164 TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK (
        lifecycle_state IN ('active', 'past_due', 'suspended', 'release_pending', 'released')
    ),
    saas_entitlement_status TEXT NOT NULL DEFAULT 'active' CHECK (
        saas_entitlement_status IN ('active', 'canceling', 'canceled', 'expired', 'past_due')
    ),
    paid_through_at TIMESTAMPTZ NULL,
    service_ended_at TIMESTAMPTZ NULL,
    past_due_started_at TIMESTAMPTZ NULL,
    suspended_at TIMESTAMPTZ NULL,
    release_pending_started_at TIMESTAMPTZ NULL,
    released_at TIMESTAMPTZ NULL,
    unfunded_company_liability BOOLEAN NOT NULL DEFAULT FALSE,
    allow_telecom_usage BOOLEAN NOT NULL DEFAULT TRUE,
    policy_id UUID NULL REFERENCES public.number_lifecycle_policies(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_phone_number_lifecycle_state UNIQUE (phone_number_id)
);

-- Indexes for querying offboarding states & unfunded exposure
CREATE INDEX IF NOT EXISTS idx_phone_number_lifecycle_states_org ON public.phone_number_lifecycle_states(organization_id);
CREATE INDEX IF NOT EXISTS idx_phone_number_lifecycle_states_state ON public.phone_number_lifecycle_states(lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_phone_number_lifecycle_states_unfunded ON public.phone_number_lifecycle_states(unfunded_company_liability) WHERE unfunded_company_liability = TRUE;

-- 3. Create public.number_lifecycle_notifications table
CREATE TABLE IF NOT EXISTS public.number_lifecycle_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    phone_number_id UUID NOT NULL REFERENCES public.phone_numbers(id) ON DELETE CASCADE,
    phone_number_e164 TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (
        event_type IN (
            'saas_cancellation_received',
            'service_end_approaching',
            'retention_grace_warning',
            'payment_renewal_required',
            'service_suspended',
            'number_release_pending',
            'final_release_warning',
            'number_released',
            'service_restored',
            'port_out_blocking_release'
        )
    ),
    idempotency_key TEXT NOT NULL,
    delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (
        delivery_status IN ('pending', 'delivered', 'failed', 'skipped')
    ),
    channel TEXT NOT NULL DEFAULT 'in_app' CHECK (
        channel IN ('in_app', 'email', 'sms', 'system')
    ),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ NULL,
    CONSTRAINT unique_lifecycle_notification_idempotency UNIQUE (organization_id, idempotency_key)
);

-- Indexes for notifications queries
CREATE INDEX IF NOT EXISTS idx_number_lifecycle_notifs_org ON public.number_lifecycle_notifications(organization_id);
CREATE INDEX IF NOT EXISTS idx_number_lifecycle_notifs_phone ON public.number_lifecycle_notifications(phone_number_id);
CREATE INDEX IF NOT EXISTS idx_number_lifecycle_notifs_event ON public.number_lifecycle_notifications(event_type);

-- Enable RLS
ALTER TABLE public.number_lifecycle_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.phone_number_lifecycle_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.number_lifecycle_notifications ENABLE ROW LEVEL SECURITY;

-- Grants
GRANT ALL ON public.number_lifecycle_policies TO service_role;
GRANT ALL ON public.phone_number_lifecycle_states TO service_role;
GRANT ALL ON public.number_lifecycle_notifications TO service_role;

GRANT SELECT ON public.number_lifecycle_policies TO authenticated;
GRANT SELECT ON public.phone_number_lifecycle_states TO authenticated;
GRANT SELECT ON public.number_lifecycle_notifications TO authenticated;

-- RLS Policies for Tenant-Isolated Read Access
CREATE POLICY tenant_select_number_lifecycle_policies ON public.number_lifecycle_policies
    FOR SELECT TO authenticated
    USING (organization_id IN (
        SELECT p.organization_id FROM public.profiles p WHERE p.id = auth.uid()
    ));

CREATE POLICY tenant_select_phone_number_lifecycle_states ON public.phone_number_lifecycle_states
    FOR SELECT TO authenticated
    USING (organization_id IN (
        SELECT p.organization_id FROM public.profiles p WHERE p.id = auth.uid()
    ));

CREATE POLICY tenant_select_number_lifecycle_notifications ON public.number_lifecycle_notifications
    FOR SELECT TO authenticated
    USING (organization_id IN (
        SELECT p.organization_id FROM public.profiles p WHERE p.id = auth.uid()
    ));

