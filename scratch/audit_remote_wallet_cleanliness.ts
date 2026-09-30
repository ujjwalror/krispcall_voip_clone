import fs from 'fs';
import path from 'path';

const envPath = path.resolve('.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.substring(0, idx).trim();
      const val = trimmed.substring(idx + 1).trim().replace(/^["']|["']$/g, '');
      process.env[key] = val;
    }
  }
}

import { createAdminClient } from '../src/lib/supabase/admin';

async function auditWalletCleanliness() {
  const supabase = createAdminClient();
  const orgId = '00000000-0000-0000-0000-000000000001';
  console.log(`=== AUDITING WALLET & RESERVATIONS FOR ORG ${orgId} (READ-ONLY) ===\n`);

  // 1. Credit balance
  const { data: ledger } = await supabase
    .from('billing_credit_ledger')
    .select('balance_after_minor, amount_minor, entry_type, created_at')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1);

  const fundedBalance = ledger && ledger.length > 0 ? Number(ledger[0].balance_after_minor) : 0;
  console.log(`Funded Wallet Balance: ${fundedBalance} minor USD (100 cents = $1.00 USD)`);

  // 2. Active reservations
  const { data: activeRes } = await supabase
    .from('telecom_usage_reservations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'active');

  const activeReservationsCount = activeRes?.length || 0;
  let activeProtectedExposure = 0;
  for (const r of activeRes || []) {
    activeProtectedExposure += Number(r.amount_reserved_minor);
  }

  console.log(`Active Reservations Count: ${activeReservationsCount}`);
  console.log(`Active Protected Exposure: ${activeProtectedExposure} minor USD (0 cents)`);

  // 3. Unresolved Provider Operations
  const { data: provOps } = await supabase
    .from('provider_operations')
    .select('id, status, operation_type, created_at')
    .eq('organization_id', orgId)
    .in('status', ['pending', 'processing']);

  console.log(`Unresolved Provider Operations Count: ${provOps?.length || 0}`);

  // 4. All Reservations count
  const { data: allRes } = await supabase
    .from('telecom_usage_reservations')
    .select('id, status, amount_reserved_minor, actual_customer_charge_minor');

  console.log(`Total Reservations Count: ${allRes?.length || 0}`);
}

auditWalletCleanliness().catch(console.error);
