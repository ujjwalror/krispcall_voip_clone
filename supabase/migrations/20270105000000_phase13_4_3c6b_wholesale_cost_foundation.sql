-- ====================================================================
-- MIGRATION: PHASE 13.4.3C SUBPHASE C.6 STAGE C.6B WHOLESALE COST FOUNDATION (REMEDIATED)
-- Date: 2027-01-05
-- Establishes server-authoritative confidential telecom wholesale economics,
-- append-only provider cost observation ledger with source authority supersession,
-- component identity, explicit correction semantics, and privacy hardening.
-- DO NOT EXECUTE REMOTELY AUTOMATICALLY — Must be applied manually by DBA in Supabase SQL Editor.
-- ====================================================================

-- 1. Create public.telecom_usage_economics table (Confidential Platform Wholesale Economics)
CREATE TABLE IF NOT EXISTS public.telecom_usage_economics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    reservation_id UUID NOT NULL UNIQUE REFERENCES public.telecom_usage_reservations(id) ON DELETE RESTRICT,
    internal_usage_id TEXT NOT NULL UNIQUE CHECK (pg_catalog.length(pg_catalog.btrim(internal_usage_id)) > 0),
    provider_account_id UUID NULL REFERENCES public.billing_provider_accounts(id) ON DELETE RESTRICT,
    settlement_ledger_id UUID NULL REFERENCES public.billing_credit_ledger(id) ON DELETE RESTRICT,
    provider_key TEXT NOT NULL DEFAULT 'twilio',
    service_type TEXT NOT NULL CHECK (service_type IN ('voice_outbound', 'voice_inbound', 'sms_outbound', 'mms_outbound', 'number_rental')),
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'neutral')),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
    
    -- Estimated Wholesale Economics (Micro & Minor)
    estimated_wholesale_rate_micro BIGINT NOT NULL CHECK (estimated_wholesale_rate_micro >= 0),
    estimated_wholesale_cost_minor BIGINT NOT NULL CHECK (estimated_wholesale_cost_minor >= 0),
    
    -- Retail Charge Snapshot (Non-authoritative Read-Only Reporting Cache)
    retail_charge_minor BIGINT NULL CHECK (retail_charge_minor IS NULL OR retail_charge_minor >= 0),
    
    -- Net Actual Provider Cost (Derived from Component Supersession)
    net_actual_provider_cost_micro BIGINT NULL,
    net_actual_provider_cost_minor BIGINT NULL CHECK (net_actual_provider_cost_minor IS NULL OR net_actual_provider_cost_minor >= 0),
    
    -- Status & Provenance Metadata
    cost_status TEXT NOT NULL DEFAULT 'cost_pending' 
        CHECK (cost_status IN ('cost_pending', 'cost_recorded', 'cost_conflict', 'cost_reconciled', 'legacy_unknown')),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Indexing for lookup & reporting queries
CREATE INDEX IF NOT EXISTS idx_telecom_usage_economics_org_status
ON public.telecom_usage_economics (organization_id, cost_status);

CREATE INDEX IF NOT EXISTS idx_telecom_usage_economics_provider_acct
ON public.telecom_usage_economics (provider_account_id) WHERE provider_account_id IS NOT NULL;

-- Trigger for updated_at on telecom_usage_economics
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_telecom_usage_economics_updated_at'
    ) THEN
        CREATE TRIGGER trg_telecom_usage_economics_updated_at
            BEFORE UPDATE ON public.telecom_usage_economics
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;


-- 2. Create public.telecom_provider_cost_observations table (Append-Only Evidence Log)
CREATE TABLE IF NOT EXISTS public.telecom_provider_cost_observations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    economics_id UUID NOT NULL REFERENCES public.telecom_usage_economics(id) ON DELETE RESTRICT,
    
    -- Component Identity (Enables additive components vs component supersession)
    cost_component TEXT NOT NULL DEFAULT 'base_usage',
    
    -- Provenance & Authority Rank
    source_authority TEXT NOT NULL 
        CHECK (source_authority IN ('preliminary_callback', 'finalized_api_fetch', 'invoice_reconciled', 'manual_adjustment')),
    authority_rank INT NOT NULL DEFAULT 10,
    
    -- Explicit Economic Classification
    economic_effect TEXT NOT NULL 
        CHECK (economic_effect IN ('charge', 'credit', 'correction_increase', 'correction_decrease', 'unknown')),
        
    cost_source TEXT NOT NULL,
    
    -- Magnitude & Raw Sign Evidence
    provider_cost_micro BIGINT NOT NULL CHECK (provider_cost_micro >= 0),
    raw_sign TEXT NOT NULL CHECK (raw_sign IN ('positive', 'negative', 'zero')),
    raw_provider_price_text TEXT NULL,
    
    -- Idempotency Fingerprint
    fingerprint TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(fingerprint)) > 0),
    
    -- Privacy-Sanitized Financial Payload Only
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    
    CONSTRAINT uq_telecom_provider_cost_obs_fingerprint UNIQUE (economics_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_telecom_provider_cost_obs_econ_comp 
ON public.telecom_provider_cost_observations(economics_id, cost_component, authority_rank DESC, observed_at DESC);


-- 3. Defense-in-Depth RLS & Security Boundary
-- Confidential Wholesale tables are STRICTLY service_role ONLY!
ALTER TABLE public.telecom_usage_economics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telecom_usage_economics FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.telecom_usage_economics TO service_role;

ALTER TABLE public.telecom_provider_cost_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telecom_provider_cost_observations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.telecom_provider_cost_observations TO service_role;


-- 4. Atomic RPC: Record Telecom Wholesale Economics Snapshot
CREATE OR REPLACE FUNCTION public.record_telecom_usage_economics_snapshot_atomic(
  p_organization_id UUID,
  p_reservation_id UUID,
  p_internal_usage_id TEXT,
  p_provider_account_id UUID DEFAULT NULL,
  p_provider_key TEXT DEFAULT 'twilio',
  p_service_type TEXT DEFAULT 'voice_outbound',
  p_direction TEXT DEFAULT 'outbound',
  p_currency TEXT DEFAULT 'USD',
  p_estimated_wholesale_rate_micro BIGINT DEFAULT 0,
  p_estimated_wholesale_cost_minor BIGINT DEFAULT 0,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_clean_usage_id TEXT;
  v_clean_currency TEXT;
  v_clean_provider TEXT;
  v_existing public.telecom_usage_economics;
  v_new_id UUID;
BEGIN
  v_clean_usage_id := pg_catalog.btrim(COALESCE(p_internal_usage_id, ''));
  v_clean_currency := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_currency, 'USD')));
  v_clean_provider := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_provider_key, 'twilio')));

  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_organization_id is required.';
  END IF;
  IF p_reservation_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_reservation_id is required.';
  END IF;
  IF length(v_clean_usage_id) = 0 THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_internal_usage_id cannot be blank.';
  END IF;
  IF p_estimated_wholesale_rate_micro < 0 THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_estimated_wholesale_rate_micro cannot be negative.';
  END IF;
  IF p_estimated_wholesale_cost_minor < 0 THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_estimated_wholesale_cost_minor cannot be negative.';
  END IF;

  -- Idempotency Check on reservation_id
  SELECT * INTO v_existing
  FROM public.telecom_usage_economics
  WHERE reservation_id = p_reservation_id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'is_duplicate', true,
      'economics_id', v_existing.id,
      'reservation_id', v_existing.reservation_id,
      'internal_usage_id', v_existing.internal_usage_id,
      'cost_status', v_existing.cost_status
    );
  END IF;

  -- Create new wholesale economics snapshot
  INSERT INTO public.telecom_usage_economics (
    organization_id,
    reservation_id,
    internal_usage_id,
    provider_account_id,
    provider_key,
    service_type,
    direction,
    currency,
    estimated_wholesale_rate_micro,
    estimated_wholesale_cost_minor,
    cost_status,
    metadata
  )
  VALUES (
    p_organization_id,
    p_reservation_id,
    v_clean_usage_id,
    p_provider_account_id,
    v_clean_provider,
    p_service_type,
    p_direction,
    v_clean_currency,
    p_estimated_wholesale_rate_micro,
    p_estimated_wholesale_cost_minor,
    'cost_pending',
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_new_id;

  RETURN jsonb_build_object(
    'success', true,
    'is_duplicate', false,
    'economics_id', v_new_id,
    'reservation_id', p_reservation_id,
    'internal_usage_id', v_clean_usage_id,
    'cost_status', 'cost_pending'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_telecom_usage_economics_snapshot_atomic FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_telecom_usage_economics_snapshot_atomic TO service_role;


-- 5. Atomic RPC: Record Provider Cost Observation with Source Supersession & Privacy Hardening
CREATE OR REPLACE FUNCTION public.record_provider_cost_observation_atomic(
  p_organization_id UUID,
  p_internal_usage_id TEXT,
  p_source_authority TEXT,
  p_economic_effect TEXT,
  p_cost_source TEXT,
  p_provider_cost_micro BIGINT,
  p_raw_sign TEXT,
  p_cost_component TEXT DEFAULT 'base_usage',
  p_raw_provider_price_text TEXT DEFAULT NULL,
  p_fingerprint TEXT DEFAULT NULL,
  p_settlement_ledger_id UUID DEFAULT NULL,
  p_retail_charge_minor BIGINT DEFAULT NULL,
  p_raw_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_clean_usage_id TEXT;
  v_clean_component TEXT;
  v_authority_rank INT;
  v_fingerprint TEXT;
  v_econ public.telecom_usage_economics;
  v_existing_obs public.telecom_provider_cost_observations;
  v_obs_id UUID;
  v_gross_charges_micro BIGINT := 0;
  v_gross_credits_micro BIGINT := 0;
  v_net_cost_micro BIGINT := 0;
  v_net_cost_minor BIGINT := 0;
  v_new_status TEXT := 'cost_recorded';
  v_sanitized_payload JSONB;
  v_has_conflict BOOLEAN := FALSE;

  -- Temporary record variable for component aggregation
  v_comp_record RECORD;
BEGIN
  v_clean_usage_id := pg_catalog.btrim(COALESCE(p_internal_usage_id, ''));
  v_clean_component := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_cost_component, 'base_usage')));
  IF length(v_clean_component) = 0 THEN
    v_clean_component := 'base_usage';
  END IF;

  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_organization_id is required.';
  END IF;
  IF length(v_clean_usage_id) = 0 THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_internal_usage_id cannot be blank.';
  END IF;
  IF p_provider_cost_micro < 0 THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_provider_cost_micro cannot be negative.';
  END IF;
  IF p_source_authority NOT IN ('preliminary_callback', 'finalized_api_fetch', 'invoice_reconciled', 'manual_adjustment') THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: Invalid p_source_authority.';
  END IF;
  IF p_economic_effect NOT IN ('charge', 'credit', 'correction_increase', 'correction_decrease', 'unknown') THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: Invalid p_economic_effect.';
  END IF;

  -- Determine Authority Rank
  CASE p_source_authority
    WHEN 'invoice_reconciled' THEN v_authority_rank := 40;
    WHEN 'manual_adjustment' THEN v_authority_rank := 30;
    WHEN 'finalized_api_fetch' THEN v_authority_rank := 20;
    WHEN 'preliminary_callback' THEN v_authority_rank := 10;
    ELSE v_authority_rank := 10;
  END CASE;

  -- Locate economics row
  SELECT * INTO v_econ
  FROM public.telecom_usage_economics
  WHERE organization_id = p_organization_id
    AND internal_usage_id = v_clean_usage_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ECONOMICS_RECORD_NOT_FOUND: No wholesale economics record found for usage id %', v_clean_usage_id;
  END IF;

  -- Determine fingerprint
  v_fingerprint := pg_catalog.btrim(COALESCE(p_fingerprint, ''));
  IF length(v_fingerprint) = 0 THEN
    v_fingerprint := digest(
      v_clean_component || ':' || p_source_authority || ':' || p_economic_effect || ':' || p_provider_cost_micro::text || ':' || COALESCE(p_raw_provider_price_text, ''),
      'sha256'
    )::text;
  END IF;

  -- Idempotency check on (economics_id, fingerprint)
  SELECT * INTO v_existing_obs
  FROM public.telecom_provider_cost_observations
  WHERE economics_id = v_econ.id
    AND fingerprint = v_fingerprint;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'is_duplicate', true,
      'observation_id', v_existing_obs.id,
      'economics_id', v_econ.id,
      'cost_status', v_econ.cost_status,
      'net_actual_provider_cost_micro', v_econ.net_actual_provider_cost_micro,
      'net_actual_provider_cost_minor', v_econ.net_actual_provider_cost_minor
    );
  END IF;

  -- Privacy Hardening: Allowlist ONLY financial/reconciliation metadata, strip all PII (From, To, Body, etc.)
  v_sanitized_payload := jsonb_strip_nulls(jsonb_build_object(
    'Price', p_raw_payload->>'Price',
    'price', p_raw_payload->>'price',
    'PriceUnit', p_raw_payload->>'PriceUnit',
    'price_unit', p_raw_payload->>'price_unit',
    'SequenceNumber', p_raw_payload->>'SequenceNumber',
    'sequence_number', p_raw_payload->>'sequence_number',
    'ApiVersion', p_raw_payload->>'ApiVersion',
    'api_version', p_raw_payload->>'api_version',
    'status', p_raw_payload->>'status',
    'CallStatus', p_raw_payload->>'CallStatus',
    'MessageStatus', p_raw_payload->>'MessageStatus',
    'ErrorCode', p_raw_payload->>'ErrorCode',
    'error_code', p_raw_payload->>'error_code'
  ));

  -- Insert append-only observation with component and authority rank
  INSERT INTO public.telecom_provider_cost_observations (
    organization_id,
    economics_id,
    cost_component,
    source_authority,
    authority_rank,
    economic_effect,
    cost_source,
    provider_cost_micro,
    raw_sign,
    raw_provider_price_text,
    fingerprint,
    raw_payload
  )
  VALUES (
    p_organization_id,
    v_econ.id,
    v_clean_component,
    p_source_authority,
    v_authority_rank,
    p_economic_effect,
    p_cost_source,
    p_provider_cost_micro,
    p_raw_sign,
    p_raw_provider_price_text,
    v_fingerprint,
    v_sanitized_payload
  )
  RETURNING id INTO v_obs_id;

  -- SOURCE AUTHORITY SUPERSESSION ALGORITHM:
  -- For each distinct cost_component under this economics_id,
  -- select the single highest-authority observation (superseding weaker preliminary evidence).
  FOR v_comp_record IN
    WITH ranked_obs AS (
      SELECT 
        cost_component,
        economic_effect,
        provider_cost_micro,
        authority_rank,
        observed_at,
        ROW_NUMBER() OVER (
          PARTITION BY cost_component 
          ORDER BY authority_rank DESC, observed_at DESC, id DESC
        ) as rank_idx,
        COUNT(*) OVER (
          PARTITION BY cost_component, authority_rank
        ) as rank_count,
        COUNT(DISTINCT provider_cost_micro) OVER (
          PARTITION BY cost_component, authority_rank
        ) as distinct_costs_in_rank
      FROM public.telecom_provider_cost_observations
      WHERE economics_id = v_econ.id
    )
    SELECT *
    FROM ranked_obs
    WHERE rank_idx = 1
  LOOP
    -- Check for same-authority conflict
    IF v_comp_record.distinct_costs_in_rank > 1 THEN
      v_has_conflict := TRUE;
    END IF;

    -- Aggregate effective economics based on economic_effect
    IF v_comp_record.economic_effect IN ('charge', 'correction_increase') THEN
      v_gross_charges_micro := v_gross_charges_micro + v_comp_record.provider_cost_micro;
    ELSIF v_comp_record.economic_effect IN ('credit', 'correction_decrease') THEN
      v_gross_credits_micro := v_gross_credits_micro + v_comp_record.provider_cost_micro;
    ELSIF v_comp_record.economic_effect = 'unknown' THEN
      v_has_conflict := TRUE;
    END IF;
  END LOOP;

  -- Net Provider Cost Micro (truthful signed magnitude)
  v_net_cost_micro := v_gross_charges_micro - v_gross_credits_micro;

  -- Convert positive net micro to minor cents via BigInt ceiling division: (netMicro + 9999) / 10000
  IF v_net_cost_micro > 0 THEN
    v_net_cost_minor := (v_net_cost_micro + 9999) / 10000;
  ELSE
    v_net_cost_minor := 0;
  END IF;

  -- Determine cost status
  IF v_has_conflict OR p_economic_effect = 'unknown' THEN
    v_new_status := 'cost_conflict';
  ELSIF p_source_authority = 'invoice_reconciled' THEN
    v_new_status := 'cost_reconciled';
  ELSE
    v_new_status := 'cost_recorded';
  END IF;

  -- Update economics summary
  UPDATE public.telecom_usage_economics
  SET
    settlement_ledger_id = COALESCE(p_settlement_ledger_id, settlement_ledger_id),
    retail_charge_minor = COALESCE(p_retail_charge_minor, retail_charge_minor),
    net_actual_provider_cost_micro = v_net_cost_micro,
    net_actual_provider_cost_minor = v_net_cost_minor,
    cost_status = v_new_status,
    updated_at = pg_catalog.now()
  WHERE id = v_econ.id;

  RETURN jsonb_build_object(
    'success', true,
    'is_duplicate', false,
    'observation_id', v_obs_id,
    'economics_id', v_econ.id,
    'cost_status', v_new_status,
    'net_actual_provider_cost_micro', v_net_cost_micro,
    'net_actual_provider_cost_minor', v_net_cost_minor
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_provider_cost_observation_atomic FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_provider_cost_observation_atomic TO service_role;
