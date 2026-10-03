import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

(globalThis as any).WebSocket = class {};

const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      let val = trimmed.slice(idx + 1).trim();
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
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

async function main() {
  console.log('--- Applying 20261225000000_phase13_4_3c5c2_auto_topup_durable_foundation.sql DDL to Database ---');

  const migrationPath = path.resolve(process.cwd(), 'supabase/migrations/20261225000000_phase13_4_3c5c2_auto_topup_durable_foundation.sql');
  const fullSql = fs.readFileSync(migrationPath, 'utf8');

  // Split migration into individual executable statements
  const statements = [
    `ALTER TABLE public.billing_auto_topup_settings
      ADD COLUMN IF NOT EXISTS threshold_state TEXT NOT NULL DEFAULT 'ARMED' CHECK (threshold_state IN ('ARMED', 'DISARMED')),
      ADD COLUMN IF NOT EXISTS configuration_generation INT NOT NULL DEFAULT 1 CHECK (configuration_generation >= 1),
      ADD COLUMN IF NOT EXISTS payment_authorization_generation INT NOT NULL DEFAULT 1 CHECK (payment_authorization_generation >= 1);`,

    `ALTER TABLE public.billing_auto_topup_triggers DROP CONSTRAINT IF EXISTS billing_auto_topup_triggers_status_check;`,

    `ALTER TABLE public.billing_auto_topup_triggers
      ADD CONSTRAINT billing_auto_topup_triggers_status_check
      CHECK (status IN (
        'initiated',
        'claimed',
        'provider_mutation_authorized',
        'processing',
        'ambiguous',
        'requires_action',
        'provider_succeeded',
        'funding_pending',
        'funded',
        'failed',
        'cancelled_race',
        'cancelled_stale_generation',
        'manual_review_required'
      ));`,

    `ALTER TABLE public.billing_auto_topup_triggers
      ADD COLUMN IF NOT EXISTS configuration_generation_snapshot INT NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS payment_authorization_generation_snapshot INT NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS threshold_minor_snapshot BIGINT NOT NULL DEFAULT 1000 CHECK (threshold_minor_snapshot > 0),
      ADD COLUMN IF NOT EXISTS recharge_amount_minor_snapshot BIGINT NOT NULL DEFAULT 2500 CHECK (recharge_amount_minor_snapshot > 0),
      ADD COLUMN IF NOT EXISTS currency_snapshot TEXT NOT NULL DEFAULT 'USD',
      ADD COLUMN IF NOT EXISTS provider_account_id_snapshot UUID REFERENCES public.billing_provider_accounts(id),
      ADD COLUMN IF NOT EXISTS provider_customer_id_snapshot TEXT,
      ADD COLUMN IF NOT EXISTS provider_payment_method_id_snapshot TEXT,
      ADD COLUMN IF NOT EXISTS provider_idempotency_key TEXT UNIQUE,
      ADD COLUMN IF NOT EXISTS lease_owner TEXT,
      ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS attempt_count INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      ADD COLUMN IF NOT EXISTS provider_payment_id TEXT;`,

    `CREATE INDEX IF NOT EXISTS idx_billing_auto_topup_triggers_status_lease
      ON public.billing_auto_topup_triggers(status, lease_expires_at);`,

    `CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_payment_ops_auto_topup_trigger
      ON public.billing_payment_operations (organization_id, (metadata->>'auto_topup_trigger_id'))
      WHERE metadata->>'auto_topup_trigger_id' IS NOT NULL;`,

    `CREATE OR REPLACE FUNCTION public.get_spendable_credit_balance_minor(p_organization_id UUID)
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
    $$;`,

    `REVOKE ALL ON FUNCTION public.get_spendable_credit_balance_minor(UUID) FROM PUBLIC, anon, authenticated;
     GRANT EXECUTE ON FUNCTION public.get_spendable_credit_balance_minor(UUID) TO service_role;`,

    `CREATE OR REPLACE FUNCTION public.claim_auto_topup_trigger_atomic(
      p_organization_id UUID,
      p_lease_owner TEXT DEFAULT 'worker_node'
    )
    RETURNS JSONB
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
    DECLARE
      v_settings public.billing_auto_topup_settings;
      v_spendable BIGINT := 0;
      v_active_holds_count INT := 0;
      v_active_debts_count INT := 0;
      v_in_flight_count INT := 0;
      v_attempt_token UUID;
      v_trigger_id UUID;
    BEGIN
      IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENTS: p_organization_id is required.';
      END IF;

      PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

      SELECT * INTO v_settings
      FROM public.billing_auto_topup_settings
      WHERE organization_id = p_organization_id
      FOR UPDATE;

      IF v_settings.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'claimed', false, 'reason', 'SETTINGS_NOT_FOUND');
      END IF;

      IF v_settings.status <> 'enabled' THEN
        RETURN jsonb_build_object('success', false, 'claimed', false, 'reason', 'AUTO_TOPUP_NOT_ENABLED', 'status', v_settings.status);
      END IF;

      IF v_settings.threshold_state <> 'ARMED' THEN
        RETURN jsonb_build_object('success', false, 'claimed', false, 'reason', 'THRESHOLD_DISARMED');
      END IF;

      v_spendable := public.get_spendable_credit_balance_minor(p_organization_id);

      IF v_spendable >= v_settings.threshold_minor THEN
        RETURN jsonb_build_object('success', false, 'claimed', false, 'reason', 'BALANCE_NOT_BELOW_THRESHOLD', 'spendable_minor', v_spendable, 'threshold_minor', v_settings.threshold_minor);
      END IF;

      SELECT COUNT(*) INTO v_active_holds_count
      FROM public.billing_financial_holds
      WHERE organization_id = p_organization_id AND status = 'active';

      IF v_active_holds_count > 0 THEN
        RETURN jsonb_build_object('success', false, 'claimed', false, 'reason', 'ACTIVE_FINANCIAL_HOLD_EXISTS');
      END IF;

      SELECT COUNT(*) INTO v_active_debts_count
      FROM public.billing_account_debts
      WHERE organization_id = p_organization_id AND status = 'unpaid';

      IF v_active_debts_count > 0 THEN
        RETURN jsonb_build_object('success', false, 'claimed', false, 'reason', 'ACTIVE_ACCOUNT_DEBT_EXISTS');
      END IF;

      SELECT COUNT(*) INTO v_in_flight_count
      FROM public.billing_auto_topup_triggers
      WHERE organization_id = p_organization_id
        AND status IN ('claimed', 'provider_mutation_authorized', 'processing', 'ambiguous', 'requires_action')
        AND (lease_expires_at IS NULL OR lease_expires_at > NOW());

      IF v_in_flight_count > 0 THEN
        RETURN jsonb_build_object('success', false, 'claimed', false, 'reason', 'IN_FLIGHT_TRIGGER_EXISTS');
      END IF;

      UPDATE public.billing_auto_topup_settings
      SET threshold_state = 'DISARMED',
          updated_at = NOW()
      WHERE id = v_settings.id;

      v_attempt_token := gen_random_uuid();

      INSERT INTO public.billing_auto_topup_triggers (
        organization_id,
        attempt_token,
        trigger_balance_minor,
        threshold_minor,
        recharge_amount_minor,
        status,
        configuration_generation_snapshot,
        payment_authorization_generation_snapshot,
        threshold_minor_snapshot,
        recharge_amount_minor_snapshot,
        currency_snapshot,
        provider_account_id_snapshot,
        provider_customer_id_snapshot,
        provider_payment_method_id_snapshot,
        lease_owner,
        lease_expires_at,
        attempt_count,
        created_at,
        updated_at
      ) VALUES (
        p_organization_id,
        v_attempt_token,
        v_spendable,
        v_settings.threshold_minor,
        v_settings.recharge_amount_minor,
        'claimed',
        v_settings.configuration_generation,
        v_settings.payment_authorization_generation,
        v_settings.threshold_minor,
        v_settings.recharge_amount_minor,
        v_settings.currency,
        v_settings.provider_account_id,
        v_settings.provider_customer_id,
        v_settings.provider_payment_method_id,
        p_lease_owner,
        NOW() + INTERVAL '15 minutes',
        1,
        NOW(),
        NOW()
      )
      RETURNING id INTO v_trigger_id;

      RETURN jsonb_build_object(
        'success', true,
        'claimed', true,
        'trigger_id', v_trigger_id,
        'attempt_token', v_attempt_token,
        'spendable_minor', v_spendable,
        'threshold_minor', v_settings.threshold_minor,
        'recharge_amount_minor', v_settings.recharge_amount_minor
      );
    END;
    $$;`,

    `REVOKE ALL ON FUNCTION public.claim_auto_topup_trigger_atomic(UUID, TEXT) FROM PUBLIC, anon, authenticated;
     GRANT EXECUTE ON FUNCTION public.claim_auto_topup_trigger_atomic(UUID, TEXT) TO service_role;`,

    `CREATE OR REPLACE FUNCTION public.rearm_auto_topup_threshold_atomic(p_organization_id UUID)
    RETURNS JSONB
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
    DECLARE
      v_settings public.billing_auto_topup_settings;
      v_spendable BIGINT := 0;
    BEGIN
      IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENTS: p_organization_id is required.';
      END IF;

      PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

      SELECT * INTO v_settings
      FROM public.billing_auto_topup_settings
      WHERE organization_id = p_organization_id
      FOR UPDATE;

      IF v_settings.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'rearmed', false, 'reason', 'SETTINGS_NOT_FOUND');
      END IF;

      IF v_settings.threshold_state <> 'DISARMED' THEN
        RETURN jsonb_build_object('success', true, 'rearmed', false, 'current_state', v_settings.threshold_state, 'reason', 'ALREADY_ARMED');
      END IF;

      v_spendable := public.get_spendable_credit_balance_minor(p_organization_id);

      IF v_spendable > v_settings.threshold_minor THEN
        UPDATE public.billing_auto_topup_settings
        SET threshold_state = 'ARMED',
            updated_at = NOW()
        WHERE id = v_settings.id;

        RETURN jsonb_build_object(
          'success', true,
          'rearmed', true,
          'previous_state', 'DISARMED',
          'current_state', 'ARMED',
          'spendable_minor', v_spendable,
          'threshold_minor', v_settings.threshold_minor
        );
      ELSE
        RETURN jsonb_build_object(
          'success', true,
          'rearmed', false,
          'current_state', 'DISARMED',
          'spendable_minor', v_spendable,
          'threshold_minor', v_settings.threshold_minor,
          'reason', 'SPENDABLE_NOT_GREATER_THAN_THRESHOLD'
        );
      END IF;
    END;
    $$;`,

    `REVOKE ALL ON FUNCTION public.rearm_auto_topup_threshold_atomic(UUID) FROM PUBLIC, anon, authenticated;
     GRANT EXECUTE ON FUNCTION public.rearm_auto_topup_threshold_atomic(UUID) TO service_role;`,

    `CREATE OR REPLACE FUNCTION public.authorize_auto_topup_provider_mutation_atomic(
      p_organization_id UUID,
      p_trigger_id UUID
    )
    RETURNS JSONB
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
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
    $$;`,

    `REVOKE ALL ON FUNCTION public.authorize_auto_topup_provider_mutation_atomic(UUID, UUID) FROM PUBLIC, anon, authenticated;
     GRANT EXECUTE ON FUNCTION public.authorize_auto_topup_provider_mutation_atomic(UUID, UUID) TO service_role;`
  ];

  for (let i = 0; i < statements.length; i++) {
    const { error } = await (supabase as any).rpc('exec_sql', { sql_query: statements[i] });
    if (error) {
      console.log(`DDL statement ${i + 1} info:`, error.message);
    } else {
      console.log(`✓ DDL statement ${i + 1} executed cleanly.`);
    }
  }
}

main().catch(console.error);
