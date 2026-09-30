import fs from 'fs';
import path from 'path';

// Load .env.local variables
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

import { createAdminClient } from '../src/lib/supabase/admin';

async function auditSecondAuthorization() {
  console.log('==================================================');
  console.log('PHASE 13.2 — READ-ONLY SECOND AUTHORIZATION AUDIT');
  console.log('==================================================\n');

  const supabase = createAdminClient();

  // Query billing_payment_operations ordered by created_at desc
  const { data: ops, error: opsErr } = await (supabase as any)
    .from('billing_payment_operations')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(5);

  if (opsErr) {
    console.error('Error querying billing_payment_operations:', opsErr);
    return;
  }

  console.log(`Found ${ops.length} payment operations:`);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    console.log(`\n--- Operation #${i + 1} ---`);
    console.log(`- ID: ${op.id}`);
    console.log(`- Organization ID: ${op.organization_id}`);
    console.log(`- Operation Type: ${op.operation_type}`);
    console.log(`- Provider: ${op.provider}`);
    console.log(`- Status: ${op.status}`);
    console.log(`- Amount Minor: ${op.amount_minor} (${op.currency})`);
    console.log(`- Idempotency Key: ${op.idempotency_key}`);
    console.log(`- Request Fingerprint: ${op.request_fingerprint}`);
    console.log(`- Provider Payment ID: ${op.provider_payment_id}`);
    console.log(`- Metadata:`, JSON.stringify(op.metadata, null, 2));
    console.log(`- Created At: ${op.created_at}`);
  }

  // Safety checks across all candidates
  const { data: providerOps } = await (supabase as any)
    .from('provider_number_operations')
    .select('*');

  const { data: phoneNumbers } = await (supabase as any)
    .from('phone_numbers')
    .select('*');

  const { data: creditLedger } = await (supabase as any)
    .from('billing_credit_ledger')
    .select('*');

  const { data: billableResources } = await (supabase as any)
    .from('organization_billable_resources')
    .select('*');

  console.log('\n==================================================');
  console.log('SAFETY CHECKS ACROSS ALL CANDIDATE OPERATIONS');
  console.log('==================================================');
  console.log(`- provider_number_operations total rows: ${providerOps?.length || 0}`);
  console.log(`- phone_numbers total rows: ${phoneNumbers?.length || 0}`);
  console.log(`- billing_credit_ledger total rows: ${creditLedger?.length || 0}`);
  console.log(`- organization_billable_resources total rows: ${billableResources?.length || 0}`);
  console.log(`- PHASE13_PAYMENT_ENABLED: ${process.env.PHASE13_PAYMENT_ENABLED || 'false'}`);

  console.log('\n==================================================');
  console.log('AUDIT COMPLETE');
  console.log('==================================================');
}

auditSecondAuthorization().catch((err) => {
  console.error('Audit execution error:', err);
});
