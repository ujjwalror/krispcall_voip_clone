-- Phase 5.2: Core Entitlement Schema & Database Provisioning
-- Plans, Features, Plan Entitlements, Organization Subscriptions, Organization Overrides

-- 1. Create public.plans table
CREATE TABLE IF NOT EXISTS public.plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_public BOOLEAN NOT NULL DEFAULT TRUE,
    trial_days_default INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Create public.features table
CREATE TABLE IF NOT EXISTS public.features (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    value_type TEXT NOT NULL CHECK (value_type IN ('boolean', 'numeric', 'text')),
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Create public.plan_entitlements table
CREATE TABLE IF NOT EXISTS public.plan_entitlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
    feature_code TEXT NOT NULL REFERENCES public.features(code) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    numeric_value NUMERIC,
    text_value TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(plan_id, feature_code)
);

-- 4. Create public.organization_subscriptions table
CREATE TABLE IF NOT EXISTS public.organization_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES public.plans(id),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'expired', 'suspended')),
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    trial_ends_at TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Create public.organization_entitlement_overrides table
CREATE TABLE IF NOT EXISTS public.organization_entitlement_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    feature_code TEXT NOT NULL REFERENCES public.features(code) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    numeric_value NUMERIC,
    text_value TEXT,
    expires_at TIMESTAMPTZ,
    reason TEXT,
    created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id, feature_code)
);

-- 6. Enable Row Level Security (RLS) on all 5 tables
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.features ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_entitlement_overrides ENABLE ROW LEVEL SECURITY;

-- 7. RLS Policies
-- Plans: Authenticated users can view active public plans OR active plans they belong to
DROP POLICY IF EXISTS plans_select_policy ON public.plans;
CREATE POLICY plans_select_policy ON public.plans
    FOR SELECT TO authenticated
    USING (is_active = TRUE AND (is_public = TRUE OR id IN (
        SELECT os.plan_id 
        FROM public.organization_subscriptions os
        JOIN public.profiles p ON p.organization_id = os.organization_id
        WHERE p.id = auth.uid() AND p.active = TRUE
    )));

-- Features: Authenticated users can view available features
DROP POLICY IF EXISTS features_select_policy ON public.features;
CREATE POLICY features_select_policy ON public.features
    FOR SELECT TO authenticated
    USING (TRUE);

-- Plan Entitlements: Authenticated users can view entitlements for visible plans
DROP POLICY IF EXISTS plan_entitlements_select_policy ON public.plan_entitlements;
CREATE POLICY plan_entitlements_select_policy ON public.plan_entitlements
    FOR SELECT TO authenticated
    USING (plan_id IN (
        SELECT id FROM public.plans WHERE is_active = TRUE
    ));

-- Organization Subscriptions: Authenticated active members can read ONLY their own organization subscription
DROP POLICY IF EXISTS organization_subscriptions_select_own ON public.organization_subscriptions;
CREATE POLICY organization_subscriptions_select_own ON public.organization_subscriptions
    FOR SELECT TO authenticated
    USING (organization_id IN (
        SELECT organization_id FROM public.profiles WHERE id = auth.uid() AND active = TRUE
    ));

-- Organization Overrides: Authenticated active members can read ONLY their own organization overrides
DROP POLICY IF EXISTS organization_entitlement_overrides_select_own ON public.organization_entitlement_overrides;
CREATE POLICY organization_entitlement_overrides_select_own ON public.organization_entitlement_overrides
    FOR SELECT TO authenticated
    USING (organization_id IN (
        SELECT organization_id FROM public.profiles WHERE id = auth.uid() AND active = TRUE
    ));

-- Direct INSERT, UPDATE, DELETE permissions are DENIED for authenticated and anon roles on all 5 tables.
-- Writes are allowed ONLY via service_role / SECURITY DEFINER backend operations.
REVOKE ALL ON TABLE public.plans FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.plans TO authenticated;

REVOKE ALL ON TABLE public.features FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.features TO authenticated;

REVOKE ALL ON TABLE public.plan_entitlements FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.plan_entitlements TO authenticated;

REVOKE ALL ON TABLE public.organization_subscriptions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.organization_subscriptions TO authenticated;

REVOKE ALL ON TABLE public.organization_entitlement_overrides FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.organization_entitlement_overrides TO authenticated;

-- 8. Seed Feature Codes
INSERT INTO public.features (code, name, value_type, description) VALUES
    ('team.seats.included', 'Included Workspace Seats', 'numeric', 'Number of workspace seats included in plan'),
    ('team.seats.max', 'Maximum Workspace Seats', 'numeric', 'Maximum allowable seats in workspace (NULL for unlimited)'),
    ('voice.calling', 'Outbound & Inbound Voice Calling', 'boolean', 'Enable telephony voice calling capabilities'),
    ('messaging.sms', 'SMS Messaging', 'boolean', 'Enable SMS text messaging capabilities'),
    ('messaging.mms', 'MMS Messaging', 'boolean', 'Enable MMS multimedia messaging capabilities'),
    ('recordings', 'Call Recording', 'boolean', 'Enable automatic and manual call recording'),
    ('crm.integrations', 'CRM Integrations', 'boolean', 'Enable CRM integrations and record linking'),
    ('crm.zoho', 'Zoho CRM Integration', 'boolean', 'Enable Zoho CRM sync and lead creation'),
    ('analytics', 'Call & Team Analytics', 'boolean', 'Enable advanced telephony analytics reporting'),
    ('ivr', 'Interactive Voice Response', 'boolean', 'Enable IVR phone menu trees'),
    ('call_queue', 'Call Queue Routing', 'boolean', 'Enable multi-agent call queues'),
    ('number.purchase', 'Phone Number Purchasing', 'boolean', 'Enable purchasing company phone numbers'),
    ('number.porting', 'Phone Number Porting', 'boolean', 'Enable porting external phone numbers'),
    ('number.max_active', 'Maximum Active Phone Numbers', 'numeric', 'Maximum number of company phone numbers allowed')
ON CONFLICT (code) DO NOTHING;

-- 9. Seed Internal Non-Public Development Plan
INSERT INTO public.plans (code, name, description, is_active, is_public, trial_days_default, sort_order) VALUES
    ('dev_unlimited', 'Development Unlimited', 'Internal development and backfill plan with unrestricted capabilities', TRUE, FALSE, NULL, 0)
ON CONFLICT (code) DO NOTHING;

-- 10. Seed Entitlements for Development Plan
DO $$
DECLARE
    v_plan_id UUID;
BEGIN
    SELECT id INTO v_plan_id FROM public.plans WHERE code = 'dev_unlimited';
    IF v_plan_id IS NOT NULL THEN
        INSERT INTO public.plan_entitlements (plan_id, feature_code, enabled, numeric_value) VALUES
            (v_plan_id, 'team.seats.included', TRUE, 100),
            (v_plan_id, 'team.seats.max', TRUE, 1000),
            (v_plan_id, 'voice.calling', TRUE, NULL),
            (v_plan_id, 'messaging.sms', TRUE, NULL),
            (v_plan_id, 'messaging.mms', TRUE, NULL),
            (v_plan_id, 'recordings', TRUE, NULL),
            (v_plan_id, 'crm.integrations', TRUE, NULL),
            (v_plan_id, 'crm.zoho', TRUE, NULL),
            (v_plan_id, 'analytics', TRUE, NULL),
            (v_plan_id, 'ivr', TRUE, NULL),
            (v_plan_id, 'call_queue', TRUE, NULL),
            (v_plan_id, 'number.purchase', TRUE, NULL),
            (v_plan_id, 'number.porting', TRUE, NULL),
            (v_plan_id, 'number.max_active', TRUE, 100)
        ON CONFLICT (plan_id, feature_code) DO NOTHING;
    END IF;
END $$;

-- 11. Backfill all existing organizations into organization_subscriptions
INSERT INTO public.organization_subscriptions (organization_id, plan_id, status)
SELECT 
    o.id,
    p.id,
    'active'
FROM public.organizations o
CROSS JOIN public.plans p
WHERE p.code = 'dev_unlimited'
  AND o.id NOT IN (SELECT organization_id FROM public.organization_subscriptions)
ON CONFLICT (organization_id) DO NOTHING;

-- 12. Update create_organization_with_owner RPC to provision subscription for new organizations automatically
CREATE OR REPLACE FUNCTION public.create_organization_with_owner(
    p_org_name TEXT,
    p_org_slug TEXT,
    p_full_name TEXT
)
RETURNS TABLE (
    organization_id UUID,
    profile_id UUID,
    slug TEXT,
    role TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID;
    v_email TEXT;
    v_org_id UUID;
    v_clean_name TEXT;
    v_base_identity TEXT;
    v_twilio_identity TEXT;
    v_suffix INT;
    v_dev_plan_id UUID;
BEGIN
    -- 1. Derive & validate authenticated user session
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized. Authenticated user session required for onboarding.';
    END IF;

    -- 2. Derive user email securely from auth.users database table
    SELECT u.email INTO v_email
    FROM auth.users u
    WHERE u.id = v_user_id;

    IF v_email IS NULL OR pg_catalog.btrim(v_email) = '' THEN
        RAISE EXCEPTION 'Authenticated user email address not found.';
    END IF;

    -- 3. Ensure user profile does not already exist
    IF EXISTS (SELECT 1 FROM public.profiles WHERE id = v_user_id) THEN
        RAISE EXCEPTION 'User profile already exists for this account.';
    END IF;

    -- 4. Validate organization name input
    IF p_org_name IS NULL OR pg_catalog.length(pg_catalog.btrim(p_org_name)) < 2 OR pg_catalog.length(pg_catalog.btrim(p_org_name)) > 100 THEN
        RAISE EXCEPTION 'Organization name must be between 2 and 100 characters long.';
    END IF;

    -- 5. Validate full name input
    IF p_full_name IS NULL OR pg_catalog.length(pg_catalog.btrim(p_full_name)) < 2 OR pg_catalog.length(pg_catalog.btrim(p_full_name)) > 100 THEN
        RAISE EXCEPTION 'Full name must be between 2 and 100 characters long.';
    END IF;

    -- 6. Validate workspace URL slug format
    IF p_org_slug IS NULL
       OR pg_catalog.length(pg_catalog.btrim(p_org_slug)) < 2
       OR pg_catalog.length(pg_catalog.btrim(p_org_slug)) > 50
       OR pg_catalog.btrim(p_org_slug) !~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$'
    THEN
        RAISE EXCEPTION 'Invalid workspace slug. Must be 2-50 lowercase alphanumeric characters or hyphens, starting and ending with a letter or digit.';
    END IF;

    -- 7. Ensure organization slug is unique
    IF EXISTS (SELECT 1 FROM public.organizations WHERE slug = pg_catalog.btrim(p_org_slug)) THEN
        RAISE EXCEPTION 'Organization workspace URL slug "%" is already taken.', pg_catalog.btrim(p_org_slug);
    END IF;

    -- 8. Safely generate database-side unique Twilio identity (Format: owner_john_doe)
    v_clean_name := pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(p_full_name), '[^a-zA-Z0-9]+', '_', 'g'));
    v_clean_name := pg_catalog.btrim(v_clean_name, '_');
    IF v_clean_name IS NULL OR v_clean_name = '' THEN
        v_clean_name := 'user';
    END IF;

    v_base_identity := 'owner_' || v_clean_name;
    v_twilio_identity := v_base_identity;
    v_suffix := 2;

    WHILE EXISTS (SELECT 1 FROM public.profiles WHERE twilio_identity = v_twilio_identity) LOOP
        v_twilio_identity := v_base_identity || '_' || v_suffix;
        v_suffix := v_suffix + 1;
    END LOOP;

    -- 9. Insert Organization (status = 'active')
    INSERT INTO public.organizations (name, slug, status)
    VALUES (pg_catalog.btrim(p_org_name), pg_catalog.btrim(p_org_slug), 'active')
    RETURNING id INTO v_org_id;

    -- 10. Provision Organization Subscription (development plan)
    SELECT id INTO v_dev_plan_id FROM public.plans WHERE code = 'dev_unlimited';
    IF v_dev_plan_id IS NULL THEN
        RAISE EXCEPTION 'Internal error: default development plan not found.';
    END IF;

    INSERT INTO public.organization_subscriptions (organization_id, plan_id, status)
    VALUES (v_org_id, v_dev_plan_id, 'active')
    ON CONFLICT (organization_id) DO NOTHING;

    -- 11. Insert Owner Profile
    INSERT INTO public.profiles (
        id,
        organization_id,
        full_name,
        email,
        role,
        extension,
        active,
        availability_status,
        twilio_identity
    )
    VALUES (
        v_user_id,
        v_org_id,
        pg_catalog.btrim(p_full_name),
        v_email,
        'owner',
        NULL,
        TRUE,
        'offline',
        v_twilio_identity
    );

    RETURN QUERY
    SELECT v_org_id, v_user_id, pg_catalog.btrim(p_org_slug), 'owner'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.create_organization_with_owner(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_organization_with_owner(TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_organization_with_owner(TEXT, TEXT, TEXT) TO authenticated;
