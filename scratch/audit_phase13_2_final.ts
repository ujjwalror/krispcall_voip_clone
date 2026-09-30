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

async function main() {
  const supabase = createAdminClient();

  const { data: ops, error: opsErr } = await (supabase as any)
    .from('billing_payment_operations')
    .select('*')
    .order('created_at', { ascending: false });

  if (opsErr) {
    console.error('Ops query error:', opsErr);
    return;
  }

  console.log(`Total Payment Operations in DB: ${ops.length}`);
  ops.forEach((op: any, i: number) => {
    console.log(`\nOp #${i + 1}:`);
    console.log(`- ID: ${op.id}`);
    console.log(`- Provider Payment ID: ${op.provider_payment_id}`);
    console.log(`- Status: ${op.status}`);
    console.log(`- Amount Minor: ${op.amount_minor} ${op.currency}`);
    console.log(`- Target Phone: ${op.metadata?.selectionContext?.phoneNumber}`);
    console.log(`- Idempotency Key: ${op.idempotency_key}`);
    console.log(`- Fingerprint: ${op.request_fingerprint}`);
    console.log(`- Created At: ${op.created_at}`);
  });

  // Check billing_webhook_events
  const { data: webhooks } = await (supabase as any)
    .from('billing_webhook_events')
    .select('*');
  console.log(`\nTotal Webhook Events in DB: ${webhooks?.length || 0}`);

  // Check provider_number_operations & phone_numbers
  const { data: pOps } = await (supabase as any).from('provider_number_operations').select('*');
  const { data: pNums } = await (supabase as any).from('phone_numbers').select('*');
  const { data: credits } = await (supabase as any).from('billing_credit_ledger').select('*');
  const { data: resources } = await (supabase as any).from('organization_billable_resources').select('*');

  console.log(`\nSafety check counts:`);
  console.log(`- provider_number_operations: ${pOps?.length || 0}`);
  console.log(`- phone_numbers: ${pNums?.length || 0}`);
  console.log(`- billing_credit_ledger: ${credits?.length || 0}`);
  console.log(`- organization_billable_resources: ${resources?.length || 0}`);
}

main().catch(console.error);
