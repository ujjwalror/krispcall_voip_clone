-- ====================================================================
-- VOIP HUB — PHASE 19C.1 MIGRATION
-- CORRECT BUSINESS PLAN IVR ENTITLEMENT (SET TO FALSE)
-- ====================================================================

DO $$
DECLARE
    v_business_id UUID;
BEGIN
    SELECT id INTO v_business_id FROM public.plans WHERE code = 'business';

    -- BUSINESS: IVR = DISABLED FOR NOW (Pro-only feature)
    IF v_business_id IS NOT NULL THEN
        INSERT INTO public.plan_entitlements (plan_id, feature_code, enabled)
        VALUES (v_business_id, 'ivr', false)
        ON CONFLICT (plan_id, feature_code) DO UPDATE SET enabled = EXCLUDED.enabled;
    END IF;
END $$;
