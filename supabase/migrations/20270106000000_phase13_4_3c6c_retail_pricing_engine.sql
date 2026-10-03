-- ====================================================================
-- MIGRATION: PHASE 13.4.3C SUBPHASE C.6 STAGE C.6C RETAIL PRICING ENGINE
-- Date: 2027-01-06
-- Establishes configurable telecom retail pricing policy ledger, platform commercial seeds,
-- and atomic policy resolution RPC with RLS security boundaries.
-- DO NOT EXECUTE REMOTELY AUTOMATICALLY — Must be applied manually by DBA in Supabase SQL Editor.
-- ====================================================================

-- 1. Create public.telecom_retail_pricing_policies table
CREATE TABLE IF NOT EXISTS public.telecom_retail_pricing_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    policy_name TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(policy_name)) > 0),
    service_type TEXT NOT NULL CHECK (service_type IN ('voice_outbound', 'voice_inbound', 'sms_outbound', 'mms_outbound', 'all')),
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'neutral', 'all')),
    destination_pattern TEXT NOT NULL DEFAULT '*' CHECK (pg_catalog.length(pg_catalog.btrim(destination_pattern)) > 0),
    pricing_mode TEXT NOT NULL DEFAULT 'markup_percentage' CHECK (pricing_mode IN ('markup_percentage', 'gross_margin_percentage', 'flat_rate')),
    markup_basis_points INT NOT NULL DEFAULT 0 CHECK (markup_basis_points >= 0),
    fixed_surcharge_micro BIGINT NOT NULL DEFAULT 0 CHECK (fixed_surcharge_micro >= 0),
    retail_floor_micro BIGINT NOT NULL DEFAULT 0 CHECK (retail_floor_micro >= 0),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
    priority INT NOT NULL DEFAULT 100,
    is_active BOOLEAN NOT NULL DEFAULT true,
    effective_start_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    effective_end_at TIMESTAMPTZ NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    
    CONSTRAINT chk_telecom_retail_pricing_policies_dates 
        CHECK (effective_end_at IS NULL OR effective_end_at >= effective_start_at)
);

-- Indexing for policy resolution lookup
CREATE INDEX IF NOT EXISTS idx_telecom_retail_pricing_policies_lookup
ON public.telecom_retail_pricing_policies (service_type, direction, is_active, currency, priority DESC);

CREATE INDEX IF NOT EXISTS idx_telecom_retail_pricing_policies_org
ON public.telecom_retail_pricing_policies (organization_id) WHERE organization_id IS NOT NULL;

-- Trigger for updated_at
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_telecom_retail_pricing_policies_updated_at'
    ) THEN
        CREATE TRIGGER trg_telecom_retail_pricing_policies_updated_at
            BEFORE UPDATE ON public.telecom_retail_pricing_policies
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;


-- 2. Seed Approved Platform-Level Global Voice Pricing Policies (25.00% / 2500 basis points)
-- Global policies have organization_id = NULL
INSERT INTO public.telecom_retail_pricing_policies (
    organization_id,
    policy_name,
    service_type,
    direction,
    destination_pattern,
    pricing_mode,
    markup_basis_points,
    fixed_surcharge_micro,
    retail_floor_micro,
    currency,
    priority,
    is_active,
    effective_start_at,
    metadata
)
VALUES
(
    NULL,
    'Global Platform Voice Outbound 25% Markup Policy',
    'voice_outbound',
    'outbound',
    '*',
    'markup_percentage',
    2500, -- 25.00% Approved Commercial Voice Markup
    0,
    0,
    'USD',
    100,
    true,
    '2026-01-01 00:00:00+00',
    '{"description": "Approved platform initial calling markup policy of 25.00% on provider wholesale cost."}'::jsonb
),
(
    NULL,
    'Global Platform Voice Inbound 25% Markup Policy',
    'voice_inbound',
    'inbound',
    '*',
    'markup_percentage',
    2500, -- 25.00% Approved Commercial Voice Markup
    0,
    0,
    'USD',
    100,
    true,
    '2026-01-01 00:00:00+00',
    '{"description": "Approved platform initial calling markup policy of 25.00% on provider wholesale cost."}'::jsonb
)
ON CONFLICT DO NOTHING;


-- 3. Defense-in-Depth RLS & Security Boundary
ALTER TABLE public.telecom_retail_pricing_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telecom_retail_pricing_policies FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.telecom_retail_pricing_policies TO service_role;


-- 4. Atomic RPC: Resolve Commercial Pricing Policy
CREATE OR REPLACE FUNCTION public.resolve_telecom_retail_pricing_policy_atomic(
  p_organization_id UUID DEFAULT NULL,
  p_service_type TEXT DEFAULT 'voice_outbound',
  p_direction TEXT DEFAULT 'outbound',
  p_destination_phone_number TEXT DEFAULT '*',
  p_currency TEXT DEFAULT 'USD',
  p_timestamp TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_eval_time TIMESTAMPTZ;
  v_clean_currency TEXT;
  v_clean_dest TEXT;
  v_matching_policies RECORD;
  v_selected_policy public.telecom_retail_pricing_policies;
  v_conflict_count INT := 0;
BEGIN
  v_eval_time := COALESCE(p_timestamp, pg_catalog.now());
  v_clean_currency := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_currency, 'USD')));
  v_clean_dest := pg_catalog.btrim(COALESCE(p_destination_phone_number, '*'));

  IF p_service_type NOT IN ('voice_outbound', 'voice_inbound', 'sms_outbound', 'mms_outbound', 'all') THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: Invalid p_service_type %', p_service_type;
  END IF;

  -- Query active effective policies for service_type/direction/currency
  WITH candidate_policies AS (
    SELECT 
      *,
      -- Scope level: Org custom pattern = 40, Org wildcard = 30, Global pattern = 20, Global wildcard = 10
      CASE 
        WHEN organization_id IS NOT NULL AND destination_pattern <> '*' AND v_clean_dest LIKE (destination_pattern || '%') THEN 40 + pg_catalog.length(destination_pattern)
        WHEN organization_id IS NOT NULL AND destination_pattern = '*' THEN 30
        WHEN organization_id IS NULL AND destination_pattern <> '*' AND v_clean_dest LIKE (destination_pattern || '%') THEN 20 + pg_catalog.length(destination_pattern)
        WHEN organization_id IS NULL AND destination_pattern = '*' THEN 10
        ELSE 0
      END as match_score
    FROM public.telecom_retail_pricing_policies
    WHERE is_active = true
      AND currency = v_clean_currency
      AND service_type IN (p_service_type, 'all')
      AND direction IN (p_direction, 'all')
      AND (organization_id IS NULL OR p_organization_id IS NULL OR organization_id = p_organization_id)
      AND effective_start_at <= v_eval_time
      AND (effective_end_at IS NULL OR effective_end_at >= v_eval_time)
  ),
  ranked_policies AS (
    SELECT 
      *,
      DENSE_RANK() OVER (ORDER BY match_score DESC, priority DESC) as rank_pos
    FROM candidate_policies
    WHERE match_score > 0
  )
  SELECT COUNT(*) INTO v_conflict_count
  FROM ranked_policies
  WHERE rank_pos = 1;

  IF v_conflict_count = 0 THEN
    RAISE EXCEPTION 'PRICING_POLICY_NOT_FOUND: No active pricing policy found for service % direction % destination %', p_service_type, p_direction, v_clean_dest;
  END IF;

  -- Select single top-ranked policy
  SELECT * INTO v_selected_policy
  FROM (
    SELECT *
    FROM candidate_policies
    WHERE match_score > 0
    ORDER BY match_score DESC, priority DESC, created_at DESC
    LIMIT 1
  ) t;

  -- Detect ambiguity conflict if multiple distinct policies share top precedence & priority
  IF v_conflict_count > 1 THEN
    -- Check if differing financial rules exist among top rank
    SELECT COUNT(DISTINCT (markup_basis_points, fixed_surcharge_micro, retail_floor_micro, pricing_mode)) INTO v_conflict_count
    FROM (
      SELECT *
      FROM candidate_policies
      WHERE match_score > 0
      ORDER BY match_score DESC, priority DESC
      LIMIT 10
    ) t;

    IF v_conflict_count > 1 THEN
      RAISE EXCEPTION 'PRICING_POLICY_CONFLICT: Multiple conflicting active policies found for service % direction %', p_service_type, p_direction;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'policy_id', v_selected_policy.id,
    'policy_name', v_selected_policy.policy_name,
    'organization_id', v_selected_policy.organization_id,
    'service_type', v_selected_policy.service_type,
    'direction', v_selected_policy.direction,
    'destination_pattern', v_selected_policy.destination_pattern,
    'pricing_mode', v_selected_policy.pricing_mode,
    'markup_basis_points', v_selected_policy.markup_basis_points,
    'fixed_surcharge_micro', v_selected_policy.fixed_surcharge_micro,
    'retail_floor_micro', v_selected_policy.retail_floor_micro,
    'currency', v_selected_policy.currency,
    'priority', v_selected_policy.priority,
    'effective_start_at', v_selected_policy.effective_start_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_telecom_retail_pricing_policy_atomic FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_telecom_retail_pricing_policy_atomic TO service_role;
