import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

(globalThis as any).WebSocket = class {};

const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of envContent.split('\n')) {
    const line = rawLine.trim();
    if (line && !line.startsWith('#') && line.includes('=')) {
      const idx = line.indexOf('=');
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && !process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseSecretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  const sql = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

  CREATE OR REPLACE FUNCTION public.authorize_auto_topup_provider_mutation_atomic(
    p_organization_id UUID,
    p_trigger_id UUID
  )
  RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, extensions, pg_temp
  AS $$
  DECLARE
    v_settings public.billing_auto_topup_settings;
    v_trigger public.billing_auto_topup_triggers;
    v_spendable BIGINT := 0;
    v_active_holds_count INT := 0;
    v_active_debts_count INT := 0;
    v_payment_op_id UUID := NULL;
    v_idempotency_key TEXT;
    v_request_fingerprint TEXT;
  BEGIN
    IF p_organization_id IS NULL OR p_trigger_id IS NULL THEN
      RAISE EXCEPTION 'INVALID_ARGUMENTS: p_organization_id and p_trigger_id are required.';
    END IF;

    PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

    SELECT * INTO v_settings
    FROM public.billing_auto_topup_settings
    WHERE organization_id = p_organization_id
    FOR UPDATE;

    IF v_settings.id IS NULL OR v_settings.status <> 'enabled' THEN
      UPDATE public.billing_auto_topup_triggers
      SET status = 'cancelled_race', error_code = 'SETTINGS_NOT_ENABLED', updated_at = NOW()
      WHERE id = p_trigger_id;

      RETURN jsonb_build_object('success', false, 'authorized', false, 'reason', 'SETTINGS_NOT_ENABLED');
    END IF;

    SELECT * INTO v_trigger
    FROM public.billing_auto_topup_triggers
    WHERE id = p_trigger_id AND organization_id = p_organization_id
    FOR UPDATE;

    IF v_trigger.id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'authorized', false, 'reason', 'TRIGGER_NOT_FOUND');
    END IF;

    IF v_trigger.status = 'provider_mutation_authorized' AND v_trigger.payment_operation_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'success', true,
        'already_authorized', true,
        'trigger_id', v_trigger.id,
        'payment_operation_id', v_trigger.payment_operation_id,
        'provider_idempotency_key', v_trigger.provider_idempotency_key
      );
    END IF;

    IF v_trigger.status NOT IN ('claimed', 'processing') THEN
      RETURN jsonb_build_object('success', false, 'authorized', false, 'reason', 'INVALID_TRIGGER_STATUS', 'status', v_trigger.status);
    END IF;

    IF v_trigger.configuration_generation_snapshot <> v_settings.configuration_generation OR
       v_trigger.payment_authorization_generation_snapshot <> v_settings.payment_authorization_generation THEN

      UPDATE public.billing_auto_topup_triggers
      SET status = 'cancelled_stale_generation',
          error_code = 'STALE_GENERATION_MISMATCH',
          updated_at = NOW()
      WHERE id = v_trigger.id;

      RETURN jsonb_build_object('success', false, 'authorized', false, 'reason', 'STALE_GENERATION_MISMATCH');
    END IF;

    v_spendable := public.get_spendable_credit_balance_minor(p_organization_id);
    IF v_spendable >= v_settings.threshold_minor THEN
      UPDATE public.billing_auto_topup_triggers
      SET status = 'cancelled_race',
          error_code = 'FUNDED_BEFORE_AUTHORIZATION',
          updated_at = NOW()
      WHERE id = v_trigger.id;

      RETURN jsonb_build_object('success', false, 'authorized', false, 'reason', 'FUNDED_BEFORE_AUTHORIZATION');
    END IF;

    SELECT COUNT(*) INTO v_active_holds_count
    FROM public.billing_financial_holds
    WHERE organization_id = p_organization_id AND status = 'active';

    SELECT COUNT(*) INTO v_active_debts_count
    FROM public.billing_account_debts
    WHERE organization_id = p_organization_id AND status = 'unpaid';

    IF v_active_holds_count > 0 OR v_active_debts_count > 0 THEN
      UPDATE public.billing_auto_topup_triggers
      SET status = 'cancelled_race',
          error_code = 'RISK_STATE_PRESENT',
          updated_at = NOW()
      WHERE id = v_trigger.id;

      RETURN jsonb_build_object('success', false, 'authorized', false, 'reason', 'RISK_STATE_PRESENT');
    END IF;

    v_idempotency_key := 'atu_pi_' || v_trigger.id::text;
    v_request_fingerprint := 'sha256:' || encode(digest('auto_topup:' || v_trigger.id::text, 'sha256'), 'hex');

    INSERT INTO public.billing_payment_operations (
      organization_id,
      auto_topup_trigger_id,
      operation_type,
      provider,
      status,
      amount_minor,
      currency,
      idempotency_key,
      request_fingerprint,
      provider_customer_id,
      provider_account_id,
      metadata,
      created_at,
      updated_at
    ) VALUES (
      p_organization_id,
      v_trigger.id,
      'credit_topup',
      'stripe',
      'pending',
      v_trigger.recharge_amount_minor_snapshot,
      v_trigger.currency_snapshot,
      v_idempotency_key,
      v_request_fingerprint,
      v_trigger.provider_customer_id_snapshot,
      v_trigger.provider_account_id_snapshot,
      jsonb_build_object('auto_topup_trigger_id', v_trigger.id::text),
      NOW(),
      NOW()
    )
    ON CONFLICT (organization_id, (metadata->>'auto_topup_trigger_id')) WHERE metadata->>'auto_topup_trigger_id' IS NOT NULL
    DO UPDATE SET updated_at = NOW()
    RETURNING id INTO v_payment_op_id;

    IF v_payment_op_id IS NULL THEN
      SELECT id INTO v_payment_op_id
      FROM public.billing_payment_operations
      WHERE organization_id = p_organization_id AND (metadata->>'auto_topup_trigger_id') = v_trigger.id::text;
    END IF;

    UPDATE public.billing_auto_topup_triggers
    SET status = 'provider_mutation_authorized',
        payment_operation_id = v_payment_op_id,
        provider_idempotency_key = v_idempotency_key,
        updated_at = NOW()
    WHERE id = v_trigger.id;

    RETURN jsonb_build_object(
      'success', true,
      'already_authorized', false,
      'trigger_id', v_trigger.id,
      'payment_operation_id', v_payment_op_id,
      'provider_idempotency_key', v_idempotency_key,
      'recharge_amount_minor', v_trigger.recharge_amount_minor_snapshot,
      'currency', v_trigger.currency_snapshot
    );
  END;
  $$;

  REVOKE ALL ON FUNCTION public.authorize_auto_topup_provider_mutation_atomic(UUID, UUID) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.authorize_auto_topup_provider_mutation_atomic(UUID, UUID) TO service_role;
  `;

  // Apply DDL to database using rpc or exec
  const { error } = await (supabase as any).rpc('exec_sql', { sql_query: sql });
  if (error) {
    console.log('rpc exec_sql info:', error.message);
  } else {
    console.log('✓ Updated RPC authorize_auto_topup_provider_mutation_atomic applied cleanly.');
  }
}

main().catch(console.error);
