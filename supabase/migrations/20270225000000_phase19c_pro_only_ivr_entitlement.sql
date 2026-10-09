-- ====================================================================
-- VOIP HUB — PHASE 19C MIGRATION
-- PRO-ONLY IVR ENTITLEMENT & CATALOG MATRIX SEED
-- ====================================================================

-- 1. Ensure commercial plans exist in public.plans
INSERT INTO public.plans (code, stable_key, name, description, is_active, is_public, sort_order)
VALUES
  ('starter', 'starter', 'Starter', 'Starter tier plan for individuals and small teams', true, true, 1),
  ('pro', 'pro', 'Pro', 'Pro tier plan with IVR, Call Queues and advanced tools', true, true, 2),
  ('business', 'business', 'Business', 'Business tier plan for enterprise teams and advanced call centers', true, true, 3)
ON CONFLICT (code) DO NOTHING;

-- 2. Seed explicit IVR feature entitlement matrix in public.plan_entitlements
DO $$
DECLARE
    v_starter_id UUID;
    v_pro_id UUID;
    v_business_id UUID;
BEGIN
    SELECT id INTO v_starter_id FROM public.plans WHERE code = 'starter';
    SELECT id INTO v_pro_id FROM public.plans WHERE code = 'pro';
    SELECT id INTO v_business_id FROM public.plans WHERE code = 'business';

    -- STARTER: IVR = DISABLED
    IF v_starter_id IS NOT NULL THEN
        INSERT INTO public.plan_entitlements (plan_id, feature_code, enabled)
        VALUES (v_starter_id, 'ivr', false)
        ON CONFLICT (plan_id, feature_code) DO UPDATE SET enabled = EXCLUDED.enabled;
    END IF;

    -- PRO: IVR = ENABLED
    IF v_pro_id IS NOT NULL THEN
        INSERT INTO public.plan_entitlements (plan_id, feature_code, enabled)
        VALUES (v_pro_id, 'ivr', true)
        ON CONFLICT (plan_id, feature_code) DO UPDATE SET enabled = EXCLUDED.enabled;
    END IF;

    -- BUSINESS: IVR = ENABLED (Business tier includes Pro capabilities in commercial matrix)
    IF v_business_id IS NOT NULL THEN
        INSERT INTO public.plan_entitlements (plan_id, feature_code, enabled)
        VALUES (v_business_id, 'ivr', true)
        ON CONFLICT (plan_id, feature_code) DO UPDATE SET enabled = EXCLUDED.enabled;
    END IF;
END $$;
