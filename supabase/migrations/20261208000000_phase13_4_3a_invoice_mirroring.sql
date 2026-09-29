-- ====================================================================
-- PUBLIC SAAS PHASE 13.4.3A — AUTHORITATIVE STRIPE INVOICE & LINE MIRRORING
-- Date: 2026-12-08
-- Evolves public.billing_invoices, creates public.billing_invoice_lines,
-- configures RLS, line & header immutability triggers, and atomic RPC.
-- READ-ONLY AUDITED / ZERO OUTBOUND STRIPE MUTATIONS
-- ====================================================================

BEGIN;

-- 1. Evolve existing public.billing_invoices table safely
ALTER TABLE public.billing_invoices
  ADD COLUMN IF NOT EXISTS provider_customer_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS provider_subscription_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS subtotal_minor BIGINT NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  ADD COLUMN IF NOT EXISTS discount_minor BIGINT NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  ADD COLUMN IF NOT EXISTS tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  ADD COLUMN IF NOT EXISTS amount_remaining_minor BIGINT NULL CHECK (amount_remaining_minor >= 0),
  ADD COLUMN IF NOT EXISTS provider_created_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS marked_uncollectible_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Backfill amount_remaining_minor for existing legacy rows if any
UPDATE public.billing_invoices
SET amount_remaining_minor = GREATEST(0, amount_due_minor - amount_paid_minor)
WHERE amount_remaining_minor IS NULL;

-- Enforce NOT NULL on amount_remaining_minor after backfill
ALTER TABLE public.billing_invoices
  ALTER COLUMN amount_remaining_minor SET NOT NULL;

-- 2. Safely migrate unique constraint on public.billing_invoices
ALTER TABLE public.billing_invoices
  DROP CONSTRAINT IF EXISTS billing_invoices_provider_invoice_id_key;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_billing_invoices_provider_invoice'
    ) THEN
        ALTER TABLE public.billing_invoices
          ADD CONSTRAINT uq_billing_invoices_provider_invoice UNIQUE (provider, provider_invoice_id);
    END IF;
END $$;

-- Index for customer lookups
CREATE INDEX IF NOT EXISTS idx_billing_invoices_provider_cust
ON public.billing_invoices(provider, provider_customer_id);

-- 3. Create public.billing_invoice_lines table
CREATE TABLE IF NOT EXISTS public.billing_invoice_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES public.billing_invoices(id) ON DELETE RESTRICT,
    provider_line_id TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(provider_line_id)) > 0),
    description TEXT NOT NULL DEFAULT '',
    quantity NUMERIC(12, 4) NOT NULL DEFAULT 1 CHECK (quantity >= 0),
    unit_amount_minor BIGINT NULL,
    unit_amount_decimal TEXT NULL,
    subtotal_minor BIGINT NOT NULL DEFAULT 0,
    amount_minor BIGINT NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
    period_start TIMESTAMPTZ NULL,
    period_end TIMESTAMPTZ NULL,
    resource_type TEXT NULL CHECK (resource_type IN ('seat', 'phone_number', 'metered_usage', 'plan_fee', 'other')),
    resource_id TEXT NULL,
    subscription_id UUID NULL REFERENCES public.organization_subscriptions(id) ON DELETE SET NULL,
    price_version_id UUID NULL REFERENCES public.billable_resource_price_versions(id) ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT uq_billing_invoice_lines_line_id UNIQUE (invoice_id, provider_line_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_invoice_lines_invoice
ON public.billing_invoice_lines(invoice_id);

-- Trigger for updated_at on billing_invoice_lines
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_billing_invoice_lines_updated_at'
    ) THEN
        CREATE TRIGGER trg_billing_invoice_lines_updated_at
            BEFORE UPDATE ON public.billing_invoice_lines
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- 4. Enable RLS and Configure Privileges on billing_invoice_lines
ALTER TABLE public.billing_invoice_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_invoice_lines FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.billing_invoice_lines TO service_role;
GRANT SELECT ON public.billing_invoice_lines TO authenticated;

DROP POLICY IF EXISTS "authenticated_select_billing_invoice_lines" ON public.billing_invoice_lines;
CREATE POLICY "authenticated_select_billing_invoice_lines"
ON public.billing_invoice_lines FOR SELECT TO authenticated
USING (
    invoice_id IN (
        SELECT inv.id FROM public.billing_invoices inv
        JOIN public.profiles prof ON prof.organization_id = inv.organization_id
        WHERE prof.id = auth.uid() AND prof.active = TRUE
    )
);

-- 5. Database-level Immutability Trigger for Finalized Invoice Lines
CREATE OR REPLACE FUNCTION public.fn_enforce_invoice_line_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_parent_status TEXT;
BEGIN
  SELECT status INTO v_parent_status
  FROM public.billing_invoices
  WHERE id = OLD.invoice_id;

  IF v_parent_status IN ('open', 'paid', 'uncollectible', 'void') THEN
    RAISE EXCEPTION 'CANNOT_MUTATE_FINALIZED_INVOICE_LINE: Line % belongs to finalized invoice % (status: %)', 
      OLD.id, OLD.invoice_id, v_parent_status;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_invoice_line_immutability ON public.billing_invoice_lines;
CREATE TRIGGER trg_enforce_invoice_line_immutability
BEFORE UPDATE OR DELETE ON public.billing_invoice_lines
FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_invoice_line_immutability();

-- 6. Database-level Immutability Trigger for Finalized Invoice Headers
CREATE OR REPLACE FUNCTION public.fn_enforce_invoice_header_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status IN ('open', 'paid', 'uncollectible', 'void') THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
       NEW.provider IS DISTINCT FROM OLD.provider OR
       NEW.provider_invoice_id IS DISTINCT FROM OLD.provider_invoice_id OR
       NEW.provider_customer_id IS DISTINCT FROM OLD.provider_customer_id OR
       NEW.provider_subscription_id IS DISTINCT FROM OLD.provider_subscription_id OR
       NEW.currency IS DISTINCT FROM OLD.currency OR
       NEW.provider_created_at IS DISTINCT FROM OLD.provider_created_at OR
       NEW.period_start IS DISTINCT FROM OLD.period_start OR
       NEW.period_end IS DISTINCT FROM OLD.period_end OR
       NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor OR
       NEW.discount_minor IS DISTINCT FROM OLD.discount_minor OR
       NEW.tax_minor IS DISTINCT FROM OLD.tax_minor OR
       NEW.amount_due_minor IS DISTINCT FROM OLD.amount_due_minor THEN
      RAISE EXCEPTION 'CANNOT_MUTATE_FINALIZED_INVOICE_HEADER: Fundamental financial identity/baseline fields are immutable once finalized.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_invoice_header_immutability ON public.billing_invoices;
CREATE TRIGGER trg_enforce_invoice_header_immutability
BEFORE UPDATE ON public.billing_invoices
FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_invoice_header_immutability();

-- 7. Atomic Stripe Invoice Mirroring RPC
CREATE OR REPLACE FUNCTION public.reconcile_stripe_invoice_atomic(
  p_organization_id UUID,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_provider_invoice_id TEXT;
  v_provider_customer_id TEXT;
  v_provider_subscription_id TEXT;
  v_status TEXT;
  v_currency TEXT;
  v_subtotal BIGINT;
  v_discount BIGINT;
  v_tax BIGINT;
  v_amount_due BIGINT;
  v_amount_paid BIGINT;
  v_amount_remaining BIGINT;
  v_mapped_cust_org UUID;
  v_mapped_sub_id UUID;
  v_sub_org_id UUID;
  v_existing_id UUID;
  v_existing_org_id UUID;
  v_existing_cust_id TEXT;
  v_existing_sub_id TEXT;
  v_existing_currency TEXT;
  v_existing_created_at TIMESTAMPTZ;
  v_existing_p_start TIMESTAMPTZ;
  v_existing_p_end TIMESTAMPTZ;
  v_existing_subtotal BIGINT;
  v_existing_discount BIGINT;
  v_existing_tax BIGINT;
  v_existing_amount_due BIGINT;
  v_existing_status TEXT;
  v_invoice_id UUID;
  v_line_item JSONB;
  v_line_id TEXT;
  v_line_currency TEXT;
  v_line_qty NUMERIC;
  v_line_subtotal BIGINT;
  v_line_amount BIGINT;
  v_line_period_start TIMESTAMPTZ;
  v_line_period_end TIMESTAMPTZ;
  v_seen_lines TEXT[];
  v_incoming_line_ids TEXT[];
  v_normalized_lines JSONB := '[]'::jsonb;
  v_period_start TIMESTAMPTZ;
  v_period_end TIMESTAMPTZ;
  v_provider_created_at TIMESTAMPTZ;
  v_finalized_at TIMESTAMPTZ;
  v_paid_at TIMESTAMPTZ;
  v_voided_at TIMESTAMPTZ;
  v_marked_uncollectible_at TIMESTAMPTZ;
  v_meta_reason TEXT;
  v_meta_coll TEXT;
  v_clean_metadata JSONB;
  v_db_line_count INT;
  v_db_line_rec RECORD;
BEGIN
  -- ==================================================================
  -- PHASE A: VALIDATION & PRE-NORMALIZATION (ZERO DML)
  -- ==================================================================

  v_provider_invoice_id := pg_catalog.btrim(COALESCE(p_payload->>'id', ''));
  v_provider_customer_id := pg_catalog.btrim(COALESCE(p_payload->>'customer', ''));
  v_provider_subscription_id := pg_catalog.btrim(COALESCE(p_payload->>'subscription', ''));
  v_status := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_payload->>'status', '')));
  v_currency := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_payload->>'currency', '')));

  IF length(v_provider_invoice_id) = 0 THEN
    RAISE EXCEPTION 'BLANK_PROVIDER_INVOICE_ID';
  END IF;

  IF v_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'INVALID_CURRENCY: Currency % must be 3 uppercase letters', v_currency;
  END IF;

  IF v_status NOT IN ('draft', 'open', 'paid', 'uncollectible', 'void') THEN
    RAISE EXCEPTION 'INVALID_INVOICE_STATUS: Status % is not supported', v_status;
  END IF;

  -- 1. Validate Organization Existence
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_organization_id) THEN
    RAISE EXCEPTION 'ORGANIZATION_NOT_FOUND';
  END IF;

  -- 2. Validate Provider Customer Mapping
  SELECT organization_id INTO v_mapped_cust_org
  FROM public.billing_provider_customers
  WHERE provider = 'stripe' AND provider_customer_id = v_provider_customer_id;

  IF v_mapped_cust_org IS NULL OR v_mapped_cust_org <> p_organization_id THEN
    RAISE EXCEPTION 'PROVIDER_CUSTOMER_ORGANIZATION_MISMATCH: Customer % does not belong to organization %',
      v_provider_customer_id, p_organization_id;
  END IF;

  -- 3. Validate Provider Subscription Mapping (Fail-Closed if subscription string present)
  IF length(v_provider_subscription_id) > 0 THEN
    SELECT sub.organization_subscription_id, os.organization_id
    INTO v_mapped_sub_id, v_sub_org_id
    FROM public.billing_provider_subscriptions sub
    JOIN public.organization_subscriptions os ON os.id = sub.organization_subscription_id
    WHERE sub.provider = 'stripe' AND sub.provider_subscription_id = v_provider_subscription_id;

    IF v_mapped_sub_id IS NULL THEN
      RAISE EXCEPTION 'PROVIDER_SUBSCRIPTION_MAPPING_NOT_FOUND: Subscription % not found in provider mappings', v_provider_subscription_id;
    END IF;

    IF v_sub_org_id <> p_organization_id THEN
      RAISE EXCEPTION 'PROVIDER_SUBSCRIPTION_ORGANIZATION_MISMATCH: Subscription % belongs to org % instead of %',
        v_provider_subscription_id, v_sub_org_id, p_organization_id;
    END IF;
  END IF;

  -- 4. Validate Presence of Contractually Required Header Financial Fields
  IF p_payload->>'subtotal' IS NULL THEN
    RAISE EXCEPTION 'MISSING_HEADER_FINANCIAL_FIELD: Required field subtotal is missing';
  END IF;

  IF p_payload->>'amount_due' IS NULL THEN
    RAISE EXCEPTION 'MISSING_HEADER_FINANCIAL_FIELD: Required field amount_due is missing';
  END IF;

  IF p_payload->>'amount_paid' IS NULL THEN
    RAISE EXCEPTION 'MISSING_HEADER_FINANCIAL_FIELD: Required field amount_paid is missing';
  END IF;

  -- Financial Non-Negative Validation on Header Totals
  BEGIN
    v_subtotal := (p_payload->>'subtotal')::BIGINT;
    v_discount := COALESCE((p_payload->>'discount_minor')::BIGINT, 0);
    v_tax := COALESCE((p_payload->>'tax_minor')::BIGINT, 0);
    v_amount_due := (p_payload->>'amount_due')::BIGINT;
    v_amount_paid := (p_payload->>'amount_paid')::BIGINT;
    v_amount_remaining := COALESCE((p_payload->>'amount_remaining')::BIGINT, GREATEST(0, v_amount_due - v_amount_paid));
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'INVALID_HEADER_MONETARY_VALUE: Header monetary fields must be valid integers';
  END;

  IF v_subtotal < 0 OR v_discount < 0 OR v_tax < 0 OR v_amount_due < 0 OR v_amount_paid < 0 OR v_amount_remaining < 0 THEN
    RAISE EXCEPTION 'INVALID_HEADER_MONETARY_VALUE: Header monetary fields cannot be negative';
  END IF;

  -- Timestamps Validation in Phase A
  BEGIN
    v_provider_created_at := CASE WHEN p_payload->>'created' IS NOT NULL THEN to_timestamp((p_payload->>'created')::BIGINT) ELSE NULL END;
    v_finalized_at := CASE WHEN p_payload->'status_transitions'->>'finalized_at' IS NOT NULL THEN to_timestamp((p_payload->'status_transitions'->>'finalized_at')::BIGINT) ELSE NULL END;
    v_paid_at := CASE WHEN p_payload->'status_transitions'->>'paid_at' IS NOT NULL THEN to_timestamp((p_payload->'status_transitions'->>'paid_at')::BIGINT) ELSE NULL END;
    v_voided_at := CASE WHEN p_payload->'status_transitions'->>'voided_at' IS NOT NULL THEN to_timestamp((p_payload->'status_transitions'->>'voided_at')::BIGINT) ELSE NULL END;
    v_marked_uncollectible_at := CASE WHEN p_payload->'status_transitions'->>'marked_uncollectible_at' IS NOT NULL THEN to_timestamp((p_payload->'status_transitions'->>'marked_uncollectible_at')::BIGINT) ELSE NULL END;

    v_period_start := CASE WHEN p_payload->>'period_start' IS NOT NULL THEN to_timestamp((p_payload->>'period_start')::BIGINT) ELSE NULL END;
    v_period_end := CASE WHEN p_payload->>'period_end' IS NOT NULL THEN to_timestamp((p_payload->>'period_end')::BIGINT) ELSE NULL END;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'INVALID_TIMESTAMP_FORMAT: Timestamp formatting failed during Phase A pre-validation';
  END;

  IF v_period_start IS NOT NULL AND v_period_end IS NOT NULL AND v_period_start > v_period_end THEN
    RAISE EXCEPTION 'INVALID_INVOICE_PERIOD: Header period_start % is greater than period_end %', v_period_start, v_period_end;
  END IF;

  -- Allowlisted Metadata Only
  v_meta_reason := p_payload->>'billing_reason';
  v_meta_coll := p_payload->>'collection_method';
  v_clean_metadata := jsonb_build_object(
    'billing_reason', COALESCE(v_meta_reason, ''),
    'collection_method', COALESCE(v_meta_coll, '')
  );

  -- 5. Validate & Pre-normalize Line Items Collection in Phase A
  v_seen_lines := ARRAY[]::TEXT[];
  v_incoming_line_ids := ARRAY[]::TEXT[];

  IF p_payload->'lines'->'data' IS NOT NULL THEN
    FOR v_line_item IN SELECT * FROM jsonb_array_elements(p_payload->'lines'->'data') LOOP
      v_line_id := pg_catalog.btrim(COALESCE(v_line_item->>'id', ''));
      IF length(v_line_id) = 0 THEN
        RAISE EXCEPTION 'BLANK_PROVIDER_LINE_ID';
      END IF;

      IF v_line_id = ANY(v_seen_lines) THEN
        RAISE EXCEPTION 'DUPLICATE_PROVIDER_LINE_ID: Line item % occurs multiple times in payload', v_line_id;
      END IF;
      v_seen_lines := array_append(v_seen_lines, v_line_id);
      v_incoming_line_ids := array_append(v_incoming_line_ids, v_line_id);

      v_line_currency := pg_catalog.upper(pg_catalog.btrim(COALESCE(v_line_item->>'currency', v_currency)));
      IF v_line_currency <> v_currency THEN
        RAISE EXCEPTION 'LINE_CURRENCY_MISMATCH: Line % currency % does not match invoice currency %',
          v_line_id, v_line_currency, v_currency;
      END IF;

      BEGIN
        v_line_qty := COALESCE((v_line_item->>'quantity')::NUMERIC, 1);
        v_line_subtotal := COALESCE((v_line_item->>'subtotal')::BIGINT, (v_line_item->>'amount')::BIGINT);
        v_line_amount := (v_line_item->>'amount')::BIGINT;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'INVALID_LINE_FINANCIAL_VALUE: Numeric parse failed for line %', v_line_id;
      END;

      IF v_line_qty < 0 THEN
        RAISE EXCEPTION 'INVALID_LINE_QUANTITY: Line % quantity cannot be negative', v_line_id;
      END IF;

      v_line_period_start := NULL;
      v_line_period_end := NULL;
      IF v_line_item->'period'->>'start' IS NOT NULL AND v_line_item->'period'->>'end' IS NOT NULL THEN
        BEGIN
          v_line_period_start := to_timestamp((v_line_item->'period'->>'start')::BIGINT);
          v_line_period_end := to_timestamp((v_line_item->'period'->>'end')::BIGINT);
        EXCEPTION WHEN OTHERS THEN
          RAISE EXCEPTION 'INVALID_LINE_PERIOD: Period parse failed for line %', v_line_id;
        END;

        IF v_line_period_start > v_line_period_end THEN
          RAISE EXCEPTION 'INVALID_LINE_PERIOD: Line % start % is greater than end %',
            v_line_id, v_line_period_start, v_line_period_end;
        END IF;
      ELSE
        v_line_period_start := v_period_start;
        v_line_period_end := v_period_end;
      END IF;

      -- Build fully pre-normalized line JSON object
      v_normalized_lines := v_normalized_lines || jsonb_build_object(
        'provider_line_id', v_line_id,
        'description', COALESCE(v_line_item->>'description', ''),
        'quantity', v_line_qty,
        'unit_amount_decimal', v_line_item->'pricing'->>'unit_amount_decimal',
        'subtotal_minor', v_line_subtotal,
        'amount_minor', v_line_amount,
        'currency', v_line_currency,
        'period_start', CASE WHEN v_line_period_start IS NOT NULL THEN to_char(v_line_period_start, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END,
        'period_end', CASE WHEN v_line_period_end IS NOT NULL THEN to_char(v_line_period_end, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END,
        'subscription_id', v_mapped_sub_id,
        'metadata', '{}'::jsonb
      );
    END LOOP;
  END IF;

  -- ==================================================================
  -- PHASE B: ATOMIC DML MUTATION (LOCKED ROW RECHECK)
  -- ==================================================================

  -- Lock row FOR UPDATE and acquire authoritative locked DB status & baseline fields
  SELECT id, organization_id, provider_customer_id, provider_subscription_id,
         currency, provider_created_at, period_start, period_end,
         subtotal_minor, discount_minor, tax_minor, amount_due_minor, status
  INTO v_existing_id, v_existing_org_id, v_existing_cust_id, v_existing_sub_id,
       v_existing_currency, v_existing_created_at, v_existing_p_start, v_existing_p_end,
       v_existing_subtotal, v_existing_discount, v_existing_tax, v_existing_amount_due, v_existing_status
  FROM public.billing_invoices
  WHERE provider = 'stripe' AND provider_invoice_id = v_provider_invoice_id
  FOR UPDATE;

  IF v_existing_org_id IS NOT NULL AND v_existing_org_id <> p_organization_id THEN
    RAISE EXCEPTION 'PROVIDER_INVOICE_ORGANIZATION_CONFLICT: Invoice % belongs to org % instead of %',
      v_provider_invoice_id, v_existing_org_id, p_organization_id;
  END IF;

  -- Locked State Machine Transition Matrix
  IF v_existing_status IS NOT NULL THEN
    IF v_existing_status = 'draft' AND v_status IN ('draft', 'open', 'paid', 'uncollectible', 'void') THEN
      -- allowed
    ELSIF v_existing_status = 'open' AND v_status IN ('open', 'paid', 'uncollectible', 'void') THEN
      -- allowed
    ELSIF v_existing_status = 'uncollectible' AND v_status IN ('uncollectible', 'paid', 'void') THEN
      -- allowed
    ELSIF v_existing_status = 'paid' AND v_status = 'paid' THEN
      -- allowed
    ELSIF v_existing_status = 'void' AND v_status = 'void' THEN
      -- allowed
    ELSE
      RAISE EXCEPTION 'INVALID_INVOICE_STATE_TRANSITION: Cannot transition invoice % from % to %',
        v_provider_invoice_id, v_existing_status, v_status;
    END IF;

    -- Finalized Baseline Conflict Detection
    IF v_existing_status IN ('open', 'paid', 'uncollectible', 'void') THEN
      IF v_existing_org_id IS DISTINCT FROM p_organization_id OR
         v_existing_cust_id IS DISTINCT FROM v_provider_customer_id OR
         v_existing_sub_id IS DISTINCT FROM v_provider_subscription_id OR
         v_existing_currency IS DISTINCT FROM v_currency OR
         v_existing_created_at IS DISTINCT FROM v_provider_created_at OR
         v_existing_p_start IS DISTINCT FROM v_period_start OR
         v_existing_p_end IS DISTINCT FROM v_period_end OR
         v_existing_subtotal IS DISTINCT FROM v_subtotal OR
         v_existing_discount IS DISTINCT FROM v_discount OR
         v_existing_tax IS DISTINCT FROM v_tax OR
         v_existing_amount_due IS DISTINCT FROM v_amount_due THEN
        RAISE EXCEPTION 'FINALIZED_INVOICE_BASELINE_CONFLICT: Authoritative incoming baseline conflicts with finalized DB invoice %',
          v_provider_invoice_id;
      END IF;

      -- Finalized Line Snapshot Exact Equality Validation
      SELECT COUNT(*) INTO v_db_line_count
      FROM public.billing_invoice_lines
      WHERE invoice_id = v_existing_id;

      IF v_db_line_count <> jsonb_array_length(v_normalized_lines) THEN
        RAISE EXCEPTION 'FINALIZED_INVOICE_LINE_CONFLICT: Incoming line count % does not match finalized DB line count % for invoice %',
          jsonb_array_length(v_normalized_lines), v_db_line_count, v_provider_invoice_id;
      END IF;

      IF v_normalized_lines IS NOT NULL AND jsonb_array_length(v_normalized_lines) > 0 THEN
        FOR v_line_item IN SELECT * FROM jsonb_array_elements(v_normalized_lines) LOOP
          SELECT provider_line_id, description, quantity, unit_amount_decimal,
                 subtotal_minor, amount_minor, currency, period_start, period_end, subscription_id
          INTO v_db_line_rec
          FROM public.billing_invoice_lines
          WHERE invoice_id = v_existing_id
            AND provider_line_id = (v_line_item->>'provider_line_id');

          IF v_db_line_rec.provider_line_id IS NULL THEN
            RAISE EXCEPTION 'FINALIZED_INVOICE_LINE_CONFLICT: Incoming line % absent from finalized invoice %',
              (v_line_item->>'provider_line_id'), v_provider_invoice_id;
          END IF;

          IF v_db_line_rec.description IS DISTINCT FROM COALESCE(v_line_item->>'description', '') OR
             v_db_line_rec.quantity IS DISTINCT FROM (v_line_item->>'quantity')::NUMERIC OR
             v_db_line_rec.unit_amount_decimal IS DISTINCT FROM (v_line_item->>'unit_amount_decimal') OR
             v_db_line_rec.subtotal_minor IS DISTINCT FROM (v_line_item->>'subtotal_minor')::BIGINT OR
             v_db_line_rec.amount_minor IS DISTINCT FROM (v_line_item->>'amount_minor')::BIGINT OR
             v_db_line_rec.currency IS DISTINCT FROM (v_line_item->>'currency') OR
             v_db_line_rec.period_start IS DISTINCT FROM (CASE WHEN v_line_item->>'period_start' IS NOT NULL THEN (v_line_item->>'period_start')::TIMESTAMPTZ ELSE NULL END) OR
             v_db_line_rec.period_end IS DISTINCT FROM (CASE WHEN v_line_item->>'period_end' IS NOT NULL THEN (v_line_item->>'period_end')::TIMESTAMPTZ ELSE NULL END) OR
             v_db_line_rec.subscription_id IS DISTINCT FROM (CASE WHEN v_line_item->>'subscription_id' IS NOT NULL THEN (v_line_item->>'subscription_id')::UUID ELSE NULL END) THEN
            RAISE EXCEPTION 'FINALIZED_INVOICE_LINE_CONFLICT: Line % fields conflict with finalized DB line on invoice %',
              (v_line_item->>'provider_line_id'), v_provider_invoice_id;
          END IF;
        END LOOP;
      END IF;
    END IF;
  END IF;

  -- STEP 1: Upsert/Create invoice header with status='draft' if row is new or currently draft
  IF v_existing_status IS NULL OR v_existing_status = 'draft' THEN
    INSERT INTO public.billing_invoices (
      organization_id, provider, provider_invoice_id, provider_customer_id, provider_subscription_id,
      status, currency, subtotal_minor, discount_minor, tax_minor,
      amount_due_minor, amount_paid_minor, amount_remaining_minor, hosted_invoice_url, invoice_pdf,
      provider_created_at, finalized_at, paid_at, voided_at, marked_uncollectible_at, period_start, period_end, metadata
    ) VALUES (
      p_organization_id, 'stripe', v_provider_invoice_id, v_provider_customer_id, v_provider_subscription_id,
      'draft', v_currency, v_subtotal, v_discount, v_tax,
      v_amount_due, v_amount_paid, v_amount_remaining, p_payload->>'hosted_invoice_url', p_payload->>'invoice_pdf',
      v_provider_created_at, v_finalized_at, v_paid_at, v_voided_at, v_marked_uncollectible_at, v_period_start, v_period_end,
      v_clean_metadata
    )
    ON CONFLICT (provider, provider_invoice_id) DO UPDATE SET
      provider_customer_id = EXCLUDED.provider_customer_id,
      provider_subscription_id = EXCLUDED.provider_subscription_id,
      subtotal_minor = EXCLUDED.subtotal_minor,
      discount_minor = EXCLUDED.discount_minor,
      tax_minor = EXCLUDED.tax_minor,
      amount_due_minor = EXCLUDED.amount_due_minor,
      amount_paid_minor = EXCLUDED.amount_paid_minor,
      amount_remaining_minor = EXCLUDED.amount_remaining_minor,
      hosted_invoice_url = COALESCE(EXCLUDED.hosted_invoice_url, public.billing_invoices.hosted_invoice_url),
      invoice_pdf = COALESCE(EXCLUDED.invoice_pdf, public.billing_invoices.invoice_pdf),
      provider_created_at = COALESCE(EXCLUDED.provider_created_at, public.billing_invoices.provider_created_at),
      period_start = COALESCE(EXCLUDED.period_start, public.billing_invoices.period_start),
      period_end = COALESCE(EXCLUDED.period_end, public.billing_invoices.period_end),
      updated_at = pg_catalog.now()
    RETURNING id INTO v_invoice_id;

    -- STEP 2: Synchronize Line Items from PRE-NORMALIZED Collection ONLY while DB parent status is 'draft'
    DELETE FROM public.billing_invoice_lines
    WHERE invoice_id = v_invoice_id
      AND provider_line_id <> ALL(v_incoming_line_ids);

    IF v_normalized_lines IS NOT NULL AND jsonb_array_length(v_normalized_lines) > 0 THEN
      FOR v_line_item IN SELECT * FROM jsonb_array_elements(v_normalized_lines) LOOP
        INSERT INTO public.billing_invoice_lines (
          invoice_id, provider_line_id, description, quantity,
          unit_amount_minor, unit_amount_decimal, subtotal_minor, amount_minor, currency,
          period_start, period_end, subscription_id, metadata
        ) VALUES (
          v_invoice_id,
          v_line_item->>'provider_line_id',
          v_line_item->>'description',
          (v_line_item->>'quantity')::NUMERIC,
          NULL, -- Explicitly NULL
          v_line_item->>'unit_amount_decimal',
          (v_line_item->>'subtotal_minor')::BIGINT,
          (v_line_item->>'amount_minor')::BIGINT,
          v_line_item->>'currency',
          CASE WHEN v_line_item->>'period_start' IS NOT NULL THEN (v_line_item->>'period_start')::TIMESTAMPTZ ELSE NULL END,
          CASE WHEN v_line_item->>'period_end' IS NOT NULL THEN (v_line_item->>'period_end')::TIMESTAMPTZ ELSE NULL END,
          CASE WHEN v_line_item->>'subscription_id' IS NOT NULL THEN (v_line_item->>'subscription_id')::UUID ELSE NULL END,
          '{}'::jsonb
        )
        ON CONFLICT (invoice_id, provider_line_id) DO UPDATE SET
          description = EXCLUDED.description,
          quantity = EXCLUDED.quantity,
          unit_amount_decimal = EXCLUDED.unit_amount_decimal,
          subtotal_minor = EXCLUDED.subtotal_minor,
          amount_minor = EXCLUDED.amount_minor,
          period_start = EXCLUDED.period_start,
          period_end = EXCLUDED.period_end,
          updated_at = pg_catalog.now();
      END LOOP;
    END IF;
  END IF;

  -- STEP 3: Transition parent header to target status AFTER line synchronization completes!
  UPDATE public.billing_invoices
  SET status = v_status,
      amount_paid_minor = v_amount_paid,
      amount_remaining_minor = v_amount_remaining,
      hosted_invoice_url = COALESCE(p_payload->>'hosted_invoice_url', hosted_invoice_url),
      invoice_pdf = COALESCE(p_payload->>'invoice_pdf', invoice_pdf),
      finalized_at = COALESCE(v_finalized_at, finalized_at),
      paid_at = COALESCE(v_paid_at, paid_at),
      voided_at = COALESCE(v_voided_at, voided_at),
      marked_uncollectible_at = COALESCE(v_marked_uncollectible_at, marked_uncollectible_at),
      updated_at = pg_catalog.now()
  WHERE provider = 'stripe' AND provider_invoice_id = v_provider_invoice_id
  RETURNING id INTO v_invoice_id;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', v_invoice_id,
    'provider_invoice_id', v_provider_invoice_id,
    'status', v_status,
    'reconciled_at', pg_catalog.now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_stripe_invoice_atomic(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_stripe_invoice_atomic(UUID, JSONB) TO service_role;

COMMIT;

