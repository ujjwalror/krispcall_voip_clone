-- ============================================================================
-- PUBLIC SAAS PHASE 13.4.3C SUBPHASE C.4B — EXACT-ONCE DATABASE & ATOMIC FUNDING FOUNDATION
-- Date: 2026-12-19
-- Establishes DB-level partial unique indexes on billing_payment_operations and billing_credit_ledger
-- to guarantee that one credit_topup payment operation creates AT MOST ONE wallet grant.
-- Defines public.fund_credit_topup_from_payment_atomic SECURITY DEFINER RPC (service_role only).
-- LOCAL MIGRATION ONLY — SUBJECT TO MANUAL DBA REVIEW. DO NOT EXECUTE REMOTELY AUTOMATICALLY.
-- ============================================================================

BEGIN;

-- 1. Pre-check assertion: Ensure no duplicate non-null provider_payment_id rows exist
DO $$
BEGIN
  IF EXISTS (
    SELECT provider, provider_payment_id, COUNT(*)
    FROM public.billing_payment_operations
    WHERE provider_payment_id IS NOT NULL
    GROUP BY provider, provider_payment_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'MIGRATION_CONFLICT: Duplicate non-null provider_payment_id rows exist in public.billing_payment_operations.';
  END IF;
END $$;

-- 2. Add partial UNIQUE index guaranteeing provider_payment_id uniqueness per provider when non-null
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_payment_ops_unique_provider_payment_id
ON public.billing_payment_operations (provider, provider_payment_id)
WHERE provider_payment_id IS NOT NULL;

-- 3. Pre-check assertion: Ensure no duplicate payment_operation grant rows exist in billing_credit_ledger
DO $$
BEGIN
  IF EXISTS (
    SELECT organization_id, reference_id, COUNT(*)
    FROM public.billing_credit_ledger
    WHERE reference_type = 'payment_operation'
      AND entry_type IN ('grant', 'auto_recharge')
      AND reference_id IS NOT NULL
    GROUP BY organization_id, reference_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'MIGRATION_CONFLICT: Duplicate payment_operation grant entries exist in public.billing_credit_ledger.';
  END IF;
END $$;

-- 4. Add narrowly scoped partial UNIQUE index protecting payment funding ledger rows
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_credit_ledger_payment_grant
ON public.billing_credit_ledger (organization_id, reference_id)
WHERE reference_type = 'payment_operation'
  AND entry_type IN ('grant', 'auto_recharge')
  AND reference_id IS NOT NULL;

-- 5. Atomic SECURITY DEFINER RPC: Fund Credit Top-Up From Payment
CREATE OR REPLACE FUNCTION public.fund_credit_topup_from_payment_atomic(
  p_payment_operation_id UUID,
  p_provider_payment_id TEXT,
  p_succeeded_amount_minor BIGINT,
  p_succeeded_currency TEXT,
  p_provider_event_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_op public.billing_payment_operations;
  v_clean_provider_payment_id TEXT;
  v_clean_currency TEXT;
  v_current_balance BIGINT := 0;
  v_wallet_currency TEXT := 'USD';
  v_new_balance BIGINT := 0;
  v_ledger_id UUID;
BEGIN
  v_clean_provider_payment_id := pg_catalog.btrim(COALESCE(p_provider_payment_id, ''));
  v_clean_currency := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_succeeded_currency, 'USD')));

  IF p_payment_operation_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_payment_operation_id is required.';
  END IF;
  IF length(v_clean_provider_payment_id) = 0 THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_provider_payment_id is required.';
  END IF;
  IF p_succeeded_amount_minor <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: p_succeeded_amount_minor must be positive.';
  END IF;

  -- Lock payment operation row exclusively
  SELECT * INTO v_op
  FROM public.billing_payment_operations
  WHERE id = p_payment_operation_id
  FOR UPDATE;

  IF v_op.id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_OPERATION_NOT_FOUND: Payment operation % does not exist.', p_payment_operation_id;
  END IF;

  IF v_op.operation_type <> 'credit_topup' THEN
    RAISE EXCEPTION 'INVALID_OPERATION_TYPE: Payment operation % type is %, expected credit_topup.',
      p_payment_operation_id, v_op.operation_type;
  END IF;

  -- Idempotent Already-Funded Path
  IF v_op.status = 'captured' THEN
    SELECT balance_after_minor INTO v_current_balance
    FROM public.billing_credit_ledger
    WHERE organization_id = v_op.organization_id
    ORDER BY created_at DESC, id DESC
    LIMIT 1;

    RETURN jsonb_build_object(
      'success', true,
      'already_funded', true,
      'payment_operation_id', v_op.id,
      'funded_amount_minor', v_op.amount_minor,
      'balance_after_minor', COALESCE(v_current_balance, 0),
      'currency', v_op.currency,
      'status', 'captured'
    );
  END IF;

  -- Validate Pre-Funding Status
  IF v_op.status IN ('canceled', 'failed', 'refunded', 'partially_refunded', 'refund_pending') THEN
    RAISE EXCEPTION 'CANNOT_FUND_TERMINAL_PAYMENT: Payment operation % status is terminal (%).',
      v_op.id, v_op.status;
  END IF;

  IF v_op.status NOT IN ('pending', 'requires_customer_action', 'authorized', 'capture_pending') THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_STATUS: Payment operation % status % is not eligible for funding.',
      v_op.id, v_op.status;
  END IF;

  -- Validate / Bind Provider Payment ID
  IF v_op.provider_payment_id IS NOT NULL AND v_op.provider_payment_id <> v_clean_provider_payment_id THEN
    RAISE EXCEPTION 'PROVIDER_PAYMENT_ID_MISMATCH: Payment operation % has provider payment ID %, expected %.',
      v_op.id, v_op.provider_payment_id, v_clean_provider_payment_id;
  END IF;

  -- Validate Amount & Currency against expectations
  IF v_op.amount_minor <> p_succeeded_amount_minor THEN
    RAISE EXCEPTION 'AMOUNT_MISMATCH: Succeeded amount % does not match payment operation amount %.',
      p_succeeded_amount_minor, v_op.amount_minor;
  END IF;

  IF v_op.currency <> v_clean_currency THEN
    RAISE EXCEPTION 'CURRENCY_MISMATCH: Succeeded currency % does not match payment operation currency %.',
      v_clean_currency, v_op.currency;
  END IF;

  -- Lock organization row for ledger calculation
  PERFORM id FROM public.organizations WHERE id = v_op.organization_id FOR UPDATE;

  -- Fetch current wallet balance & currency
  SELECT balance_after_minor, currency INTO v_current_balance, v_wallet_currency
  FROM public.billing_credit_ledger
  WHERE organization_id = v_op.organization_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  v_current_balance := COALESCE(v_current_balance, 0);
  v_wallet_currency := COALESCE(v_wallet_currency, 'USD');

  IF v_wallet_currency <> v_op.currency THEN
    RAISE EXCEPTION 'WALLET_CURRENCY_MISMATCH: Wallet currency % does not match payment currency %.',
      v_wallet_currency, v_op.currency;
  END IF;

  v_new_balance := v_current_balance + v_op.amount_minor;

  -- 6. Insert Exactly One Ledger Grant Entry
  INSERT INTO public.billing_credit_ledger (
    organization_id, entry_type, amount_minor, balance_after_minor,
    currency, description, reference_type, reference_id
  ) VALUES (
    v_op.organization_id, 'grant', v_op.amount_minor, v_new_balance,
    v_op.currency, 'Prepaid calling credit top-up', 'payment_operation', v_op.id::text
  ) RETURNING id INTO v_ledger_id;

  -- 7. Update Payment Operation to Captured State
  UPDATE public.billing_payment_operations
  SET status = 'captured',
      provider_payment_id = v_clean_provider_payment_id,
      updated_at = NOW()
  WHERE id = v_op.id;

  RETURN jsonb_build_object(
    'success', true,
    'already_funded', false,
    'payment_operation_id', v_op.id,
    'ledger_entry_id', v_ledger_id,
    'funded_amount_minor', v_op.amount_minor,
    'balance_after_minor', v_new_balance,
    'currency', v_op.currency,
    'status', 'captured'
  );
END;
$$;

-- 8. REVOKE EXECUTE from public client roles & GRANT strictly to service_role
REVOKE ALL ON FUNCTION public.fund_credit_topup_from_payment_atomic(UUID, TEXT, BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fund_credit_topup_from_payment_atomic(UUID, TEXT, BIGINT, TEXT, TEXT) TO service_role;

COMMIT;
