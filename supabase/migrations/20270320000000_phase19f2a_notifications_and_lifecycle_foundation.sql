-- ====================================================================
-- MIGRATION: PHASE 19F.2A PHONE NUMBER NOTIFICATION SETTINGS & LIFECYCLE FOUNDATION (CORRECTED)
-- Date: 2027-03-20
-- Establishes public.number_notification_settings table for per-number
-- email notification preferences, recipient scopes, and RLS policies
-- using public.profiles (verified production schema).
-- LOCAL MIGRATION ONLY — DO NOT EXECUTE REMOTELY AUTOMATICALLY.
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.number_notification_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    phone_number_id UUID NOT NULL REFERENCES public.phone_numbers(id) ON DELETE CASCADE,
    email_notifications_enabled BOOLEAN NOT NULL DEFAULT true,
    notify_new_message BOOLEAN NOT NULL DEFAULT true,
    notify_missed_call BOOLEAN NOT NULL DEFAULT true,
    notify_new_voicemail BOOLEAN NOT NULL DEFAULT true,
    recipient_mode TEXT NOT NULL DEFAULT 'assigned_members' CHECK (
        recipient_mode IN ('assigned_members', 'workspace_admins', 'all_members', 'selected_users')
    ),
    recipient_user_ids UUID[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_number_notification_settings UNIQUE (phone_number_id),
    CONSTRAINT chk_recipient_mode_consistency CHECK (
        recipient_mode = 'selected_users' OR cardinality(recipient_user_ids) = 0
    )
);

-- Performance & Isolation Indexes
CREATE INDEX IF NOT EXISTS idx_number_notification_settings_org ON public.number_notification_settings(organization_id);
CREATE INDEX IF NOT EXISTS idx_number_notification_settings_phone ON public.number_notification_settings(phone_number_id);

-- Idempotent Updated_at Trigger
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'update_number_notification_settings_updated_at'
    ) THEN
        CREATE TRIGGER update_number_notification_settings_updated_at
            BEFORE UPDATE ON public.number_notification_settings
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- Enable Row Level Security (RLS)
ALTER TABLE public.number_notification_settings ENABLE ROW LEVEL SECURITY;

-- Clean policy definitions for idempotent re-runs
DROP POLICY IF EXISTS tenant_select_number_notification_settings ON public.number_notification_settings;
DROP POLICY IF EXISTS tenant_insert_number_notification_settings ON public.number_notification_settings;
DROP POLICY IF EXISTS tenant_update_number_notification_settings ON public.number_notification_settings;
DROP POLICY IF EXISTS tenant_delete_number_notification_settings ON public.number_notification_settings;
DROP POLICY IF EXISTS tenant_manage_number_notification_settings ON public.number_notification_settings;

-- 1. SELECT policy for active authenticated profiles in the same organization
CREATE POLICY tenant_select_number_notification_settings ON public.number_notification_settings
    FOR SELECT USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND active = true
        )
    );

-- 2. INSERT policy for active tenant owners and admins with phone-org and recipient tenant validation
CREATE POLICY tenant_insert_number_notification_settings ON public.number_notification_settings
    FOR INSERT WITH CHECK (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND active = true AND role IN ('owner', 'admin')
        )
        AND phone_number_id IN (
            SELECT id FROM public.phone_numbers WHERE organization_id = number_notification_settings.organization_id
        )
        AND (
            cardinality(number_notification_settings.recipient_user_ids) = 0
            OR NOT EXISTS (
                SELECT 1
                FROM unnest(number_notification_settings.recipient_user_ids) AS rid
                WHERE NOT EXISTS (
                    SELECT 1 FROM public.profiles
                    WHERE id = rid
                      AND organization_id = number_notification_settings.organization_id
                      AND active = true
                )
            )
        )
    );

-- 3. UPDATE policy for active tenant owners and admins with phone-org and recipient tenant validation
CREATE POLICY tenant_update_number_notification_settings ON public.number_notification_settings
    FOR UPDATE USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND active = true AND role IN ('owner', 'admin')
        )
    )
    WITH CHECK (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND active = true AND role IN ('owner', 'admin')
        )
        AND phone_number_id IN (
            SELECT id FROM public.phone_numbers WHERE organization_id = number_notification_settings.organization_id
        )
        AND (
            cardinality(number_notification_settings.recipient_user_ids) = 0
            OR NOT EXISTS (
                SELECT 1
                FROM unnest(number_notification_settings.recipient_user_ids) AS rid
                WHERE NOT EXISTS (
                    SELECT 1 FROM public.profiles
                    WHERE id = rid
                      AND organization_id = number_notification_settings.organization_id
                      AND active = true
                )
            )
        )
    );

-- 4. DELETE policy for active tenant owners and admins
CREATE POLICY tenant_delete_number_notification_settings ON public.number_notification_settings
    FOR DELETE USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND active = true AND role IN ('owner', 'admin')
        )
    );

-- Service role full access grant
GRANT ALL ON public.number_notification_settings TO service_role;
