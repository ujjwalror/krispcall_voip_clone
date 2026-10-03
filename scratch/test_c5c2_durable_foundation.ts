import fs from 'fs';
import path from 'path';
import assert from 'assert';

(globalThis as any).WebSocket = class {};

import { createClient } from '@supabase/supabase-js';
import { CreditAutoTopupService } from '../src/lib/billing/creditAutoTopupService';

// Load .env.local
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

const serviceSupabase = createClient(supabaseUrl, supabaseSecretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Deploy local migration DDL first for tests
async function deployLocalMigrationDDL() {
  const migrationPath = path.resolve(process.cwd(), 'supabase/migrations/20261225000000_phase13_4_3c5c2_auto_topup_durable_foundation.sql');
  const ddl = fs.readFileSync(migrationPath, 'utf8');

  // Execute DDL blocks using raw REST or tsx runner
  // We can call postgres RPC or execute statements if helper available
}

async function runC5C2TestSuite() {
  console.log('================================================================');
  console.log('PHASE 13.4.3C SUBPHASE C.5C.2 — ADVERSARIAL FOUNDATION TEST SUITE');
  console.log('================================================================\n');

  const testOrgId = '00000000-0000-0000-0000-000000000001';

  // 1. Verify spendable balance primitive
  const spendable = await CreditAutoTopupService.getSpendableCreditBalanceMinor(serviceSupabase, testOrgId);
  console.log(`[Test 1] Authoritative Spendable Balance: ${spendable} minor USD`);
  assert(typeof spendable === 'number' && spendable >= 0, 'Spendable balance must be non-negative number');

  // 2. Check settings row state
  const { data: settingsRow } = await (serviceSupabase as any)
    .from('billing_auto_topup_settings')
    .select('*')
    .eq('organization_id', testOrgId)
    .single();

  console.log(`[Test 2] Current Settings Status: ${settingsRow?.status}, Threshold State: ${settingsRow?.threshold_state}`);
  assert.strictEqual(settingsRow?.status, 'enabled', 'Settings status should be enabled from C.5B recovery');

  // 3. Test re-arm evaluator on current balance ($502.00 > $10.00 threshold)
  const rearmResult = await CreditAutoTopupService.rearmAutoTopupThresholdAtomic(serviceSupabase, testOrgId);
  console.log('[Test 3] Re-arm Evaluator Result:', JSON.stringify(rearmResult));
  assert.strictEqual(rearmResult.success, true, 'Re-arm RPC must return success: true');

  // 4. Test Customer DTO privacy compliance
  const dtoResult = await CreditAutoTopupService.getAutoTopupSettings(serviceSupabase, testOrgId);
  console.log('[Test 4] Customer DTO Privacy Check:', JSON.stringify(dtoResult.settings));
  const dtoKeys = Object.keys(dtoResult.settings);
  const forbiddenKeys = dtoKeys.filter(k => k.includes('provider') || k.includes('cus_') || k.includes('pm_') || k.includes('seti_') || k.includes('secret'));
  assert.strictEqual(forbiddenKeys.length, 0, 'Customer DTO must NOT expose internal provider keys');

  console.log('\n================================================================');
  console.log('C.5C.2 ADVERSARIAL TEST SUITE PASSED CLEANLY');
  console.log('================================================================\n');
}

runC5C2TestSuite().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
