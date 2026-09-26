-- Forward-only configuration update for Phase 12.4 Pricing Correction
-- Approved pricing policy: Customer retail price = Provider cost + MAX(30% of cost, USD $2.00 minimum markup)
-- Deactivates historical demo explicit retail overrides so marketplace prices derive dynamically from provider cost + policy.

BEGIN;

-- 1. Deactivate explicit demo retail overrides to enforce dynamic pricing policy
UPDATE public.phone_number_retail_prices
SET is_active = false,
    updated_at = NOW()
WHERE is_active = true;

-- 2. Update launch pricing policies to use USD $2.00 minimum fixed margin (200 minor units) and no rounding rule
UPDATE public.phone_number_pricing_policies
SET target_margin_pct = 30.00,
    minimum_fixed_margin_minor = 200,
    rounding_rule = 'none',
    updated_at = NOW()
WHERE is_active = true;

COMMIT;
