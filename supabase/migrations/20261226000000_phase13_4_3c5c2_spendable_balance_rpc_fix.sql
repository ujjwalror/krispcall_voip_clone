-- Phase 13.4.3C Subphase C.5C.2E Remediation Migration
-- Forward-only fix for spendable balance RPC table reference.
-- Replaces non-existent relation public.billing_telecom_reservations with public.telecom_usage_reservations (amount_reserved_minor).

CREATE OR REPLACE FUNCTION public.get_spendable_credit_balance_minor(p_organization_id UUID)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_funded BIGINT := 0;
  v_reservations BIGINT := 0;
  v_holds BIGINT := 0;
  v_spendable BIGINT := 0;
BEGIN
  SELECT COALESCE(balance_after_minor, 0) INTO v_funded
  FROM public.billing_credit_ledger
  WHERE organization_id = p_organization_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  SELECT COALESCE(SUM(amount_reserved_minor), 0) INTO v_reservations
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id AND status = 'active';

  SELECT COALESCE(SUM(amount_minor), 0) INTO v_holds
  FROM public.billing_financial_holds
  WHERE organization_id = p_organization_id AND status = 'active';

  v_spendable := GREATEST(0, v_funded - v_reservations - v_holds);
  RETURN v_spendable;
END;
$$;

REVOKE ALL ON FUNCTION public.get_spendable_credit_balance_minor(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_spendable_credit_balance_minor(UUID) TO service_role;
