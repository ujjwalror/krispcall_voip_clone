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
      const val = trimmed.slice(idx + 1).trim();
      if (key && !process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

async function main() {
  console.log('--- Applying 20261214000000_phase13_4_3b2e_experiment_authorizations.sql to DB ---');
  
  const ddl1 = `
    CREATE TABLE IF NOT EXISTS public.telecom_experiment_authorizations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
      destination_number TEXT NOT NULL,
      initial_exposure_seconds INT NOT NULL DEFAULT 30 CHECK (initial_exposure_seconds >= 10 AND initial_exposure_seconds <= 3600),
      max_initial_exposure_seconds INT NOT NULL DEFAULT 300 CHECK (max_initial_exposure_seconds >= 30 AND max_initial_exposure_seconds <= 7200),
      enforcement_mode TEXT NOT NULL DEFAULT 'enforce' CHECK (enforcement_mode IN ('disabled', 'shadow_log', 'enforce')),
      status TEXT NOT NULL DEFAULT 'armed' CHECK (status IN ('armed', 'consumed', 'expired', 'cancelled')),
      bound_call_id UUID REFERENCES public.calls(id) ON DELETE SET NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  const ddl2 = `
    CREATE UNIQUE INDEX IF NOT EXISTS uq_telecom_exp_auth_bound_call_id 
    ON public.telecom_experiment_authorizations (bound_call_id) 
    WHERE bound_call_id IS NOT NULL;
  `;

  const ddl3 = `
    CREATE INDEX IF NOT EXISTS idx_telecom_exp_auth_org_dest_status 
    ON public.telecom_experiment_authorizations (organization_id, destination_number, status, expires_at);
  `;

  const ddl4 = `
    ALTER TABLE public.telecom_experiment_authorizations ENABLE ROW LEVEL SECURITY;
  `;

  const ddl5 = `
    CREATE OR REPLACE FUNCTION public.arm_telecom_experiment_authorization_atomic(
      p_organization_id UUID,
      p_destination_number TEXT,
      p_initial_exposure_seconds INT DEFAULT 30,
      p_max_initial_exposure_seconds INT DEFAULT 300,
      p_enforcement_mode TEXT DEFAULT 'enforce',
      p_ttl_seconds INT DEFAULT 600
    )
    RETURNS JSONB
    LANGUAGE plpgsql
    SECURITY DEFINER
    AS $$
    DECLARE
      v_auth_id UUID;
      v_expires_at TIMESTAMPTZ;
      v_norm_dest TEXT;
    BEGIN
      v_norm_dest := trim(p_destination_number);
      v_expires_at := NOW() + (p_ttl_seconds || ' seconds')::INTERVAL;

      UPDATE public.telecom_experiment_authorizations
      SET status = 'expired', updated_at = NOW()
      WHERE organization_id = p_organization_id
        AND destination_number = v_norm_dest
        AND status = 'armed'
        AND expires_at <= NOW();

      INSERT INTO public.telecom_experiment_authorizations (
        organization_id,
        destination_number,
        initial_exposure_seconds,
        max_initial_exposure_seconds,
        enforcement_mode,
        status,
        expires_at
      ) VALUES (
        p_organization_id,
        v_norm_dest,
        p_initial_exposure_seconds,
        p_max_initial_exposure_seconds,
        p_enforcement_mode,
        'armed',
        v_expires_at
      ) RETURNING id INTO v_auth_id;

      RETURN jsonb_build_object(
        'success', true,
        'authorization_id', v_auth_id,
        'organization_id', p_organization_id,
        'destination_number', v_norm_dest,
        'initial_exposure_seconds', p_initial_exposure_seconds,
        'enforcement_mode', p_enforcement_mode,
        'expires_at', v_expires_at
      );
    END;
    $$;
  `;

  const ddl6 = `
    CREATE OR REPLACE FUNCTION public.consume_telecom_experiment_authorization_atomic(
      p_organization_id UUID,
      p_call_id UUID,
      p_destination_number TEXT
    )
    RETURNS JSONB
    LANGUAGE plpgsql
    SECURITY DEFINER
    AS $$
    DECLARE
      v_record RECORD;
      v_norm_dest TEXT;
    BEGIN
      v_norm_dest := trim(p_destination_number);

      SELECT * INTO v_record
      FROM public.telecom_experiment_authorizations
      WHERE organization_id = p_organization_id
        AND destination_number = v_norm_dest
        AND status = 'armed'
        AND expires_at > NOW()
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED;

      IF v_record.id IS NULL THEN
        RETURN jsonb_build_object(
          'consumed', false,
          'reason', 'NO_ARMED_AUTHORIZATION_FOUND'
        );
      END IF;

      UPDATE public.telecom_experiment_authorizations
      SET status = 'consumed',
          bound_call_id = p_call_id,
          updated_at = NOW()
      WHERE id = v_record.id;

      RETURN jsonb_build_object(
        'consumed', true,
        'authorization_id', v_record.id,
        'organization_id', v_record.organization_id,
        'bound_call_id', p_call_id,
        'initial_exposure_seconds', v_record.initial_exposure_seconds,
        'max_initial_exposure_seconds', v_record.max_initial_exposure_seconds,
        'enforcement_mode', v_record.enforcement_mode
      );
    END;
    $$;
  `;

  // Execute DDLs via exec_sql RPC if present or postgres query
  const ddls = [ddl1, ddl2, ddl3, ddl4, ddl5, ddl6];
  for (let i = 0; i < ddls.length; i++) {
    const { error } = await (supabase as any).rpc('exec_sql', { sql_query: ddls[i] });
    if (error) {
      console.log(`DDL step ${i + 1} exec_sql info:`, error.message);
    } else {
      console.log(`✓ DDL step ${i + 1} applied cleanly.`);
    }
  }
}

main().catch(console.error);
