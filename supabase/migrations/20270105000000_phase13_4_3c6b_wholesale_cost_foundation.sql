-- ====================================================================
-- MIGRATION: PHASE 13.4.3C SUBPHASE C.6 STAGE C.6B WHOLESALE COST FOUNDATION
-- Date: 2027-01-05
-- Establishes server-authoritative confidential telecom wholesale economics,
-- append-only provider cost observation ledger, and defense-in-depth security boundary.
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
    
    -- Net Actual Provider Cost (Derived from Authoritative Observations)
    net_actual_provider_cost_micro BIGINT NULL CHECK (net_actual_provider_cost_micro IS NULL OR net_actual_provider_cost_micro >= 0),
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
    
    -- Provenance & Authority
    source_authority TEXT NOT NULL 
        CHECK (source_authority IN ('preliminary_callback', 'finalized_api_fetch', 'invoice_reconciled', 'manual_adjustment')),
    
    -- Explicit Economic Classification
    economic_effect TEXT NOT NULL 
        CHECK (economic_effect IN ('charge', 'credit', 'correction', 'unknown')),
        
    cost_source TEXT NOT NULL,
    
    -- Magnitude & Raw Sign Evidence
    provider_cost_micro BIGINT NOT NULL CHECK (provider_cost_micro >= 0),
    raw_sign TEXT NOT NULL CHECK (raw_sign IN ('positive', 'negative', 'zero')),
    raw_provider_price_text TEXT NULL,
    
    -- Idempotency Fingerprint
    fingerprint TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(fingerprint)) > 0),
    
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    
    CONSTRAINT uq_telecom_provider_cost_obs_fingerprint UNIQUE (economics_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_telecom_provider_cost_obs_econ 
ON public.telecom_provider_cost_observations(economics_id, observed_at DESC);


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


-- 5. Atomic RPC: Record Provider Cost Observation & Update Net Wholesale Economics
CREATE OR REPLACE FUNCTION public.record_provider_cost_observation_atomic(
  p_organization_id UUID,
  p_internal_usage_id TEXT,
  p_source_authority TEXT,
  p_economic_effect TEXT,
  p_cost_source TEXT,
  p_provider_cost_micro BIGINT,
  p_raw_sign TEXT,
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
  v_fingerprint TEXT;
  v_econ public.telecom_usage_economics;
  v_existing_obs public.telecom_provider_cost_observations;
  v_obs_id UUID;
  v_gross_charges_micro BIGINT := 0;
  v_gross_credits_micro BIGINT := 0;
  v_net_cost_micro BIGINT := 0;
  v_net_cost_minor BIGINT := 0;
  v_new_status TEXT := 'cost_recorded';
BEGIN
  v_clean_usage_id := pg_catalog.btrim(COALESCE(p_internal_usage_id, ''));

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
  IF p_economic_effect NOT IN ('charge', 'credit', 'correction', 'unknown') THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: Invalid p_economic_effect.';
  END IF;

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
      p_source_authority || ':' || p_economic_effect || ':' || p_provider_cost_micro::text || ':' || COALESCE(p_raw_provider_price_text, ''),
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
      'net_actual_provider_cost_minor', v_econ.net_actual_provider_cost_minor
    );
  END IF;

  -- Insert append-only observation
  INSERT INTO public.telecom_provider_cost_observations (
    organization_id,
    economics_id,
    source_authority,
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
    p_source_authority,
    p_economic_effect,
    p_cost_source,
    p_provider_cost_micro,
    p_raw_sign,
    p_raw_provider_price_text,
    v_fingerprint,
    COALESCE(p_raw_payload, '{}'::jsonb)
  )
  RETURNING id INTO v_obs_id;

  -- Calculate updated net provider cost micro across all observations
  SELECT 
    COALESCE(SUM(provider_cost_micro) FILTER (WHERE economic_effect = 'charge'), 0),
    COALESCE(SUM(provider_cost_micro) FILTER (WHERE economic_effect = 'credit'), 0)
  INTO v_gross_charges_micro, v_gross_credits_micro
  FROM public.telecom_provider_cost_observations
  WHERE economics_id = v_econ.id;

  IF v_gross_charges_micro >= v_gross_credits_micro THEN
    v_net_cost_micro := v_gross_charges_micro - v_gross_credits_micro;
  ELSE
    v_net_cost_micro := 0;
  END IF;

  -- Convert net micro to minor cents via BigInt ceiling division: (netMicro + 9999) / 10000
  IF v_net_cost_micro > 0 THEN
    v_net_cost_minor := (v_net_cost_micro + 9999) / 10000;
  ELSE
    v_net_cost_minor := 0;
  END IF;

  -- Determine cost status
  IF p_economic_effect = 'unknown' THEN
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
