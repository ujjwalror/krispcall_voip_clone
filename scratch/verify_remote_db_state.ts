import fs from 'fs';
import path from 'path';
import { createAdminClient } from '../src/lib/supabase/admin';

// Parse .env.local
try {
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...vals] = trimmed.split('=');
        if (key && vals.length > 0) {
          process.env[key.trim()] = vals.join('=').trim().replace(/^["']|["']$/g, '');
        }
      }
    });
  }
} catch (err) {}

async function verifyRemoteDbState() {
  console.log('====================================================');
  console.log('AUDITING REMOTE SUPABASE DATABASE STATE');
  console.log('====================================================\n');

  const supabase = createAdminClient();

  const tables = [
    'billing_payment_operations',
    'billing_credit_ledger',
    'organization_billable_resources',
    'billable_resource_price_versions',
    'organization_billing_controls',
    'billing_invoices',
  ];

  let missingCount = 0;
  let presentCount = 0;

  for (const table of tables) {
    const { data, error } = await (supabase as any).from(table).select('id').limit(1);
    if (error) {
      console.log(`[ABSENT] public.${table}: ${error.message}`);
      missingCount++;
    } else {
      console.log(`[PRESENT] public.${table}: Exists in remote schema cache.`);
      presentCount++;
    }
  }

  // Check RPCs
  const { error: rpc1Err } = await (supabase as any).rpc('prevent_credit_ledger_mutation');
  const rpc1Found = !rpc1Err || !rpc1Err.message.includes('Could not find');
  console.log(`[RPC Check] prevent_credit_ledger_mutation: ${rpc1Found ? 'EXISTS' : 'ABSENT'}`);

  const { error: rpc2Err } = await (supabase as any).rpc('record_credit_ledger_entry_atomic', {
    p_organization_id: '00000000-0000-0000-0000-000000000000',
    p_entry_type: 'grant',
    p_amount_minor: 100,
    p_currency: 'USD',
    p_description: 'test',
  });
  const rpc2Found = !rpc2Err || !rpc2Err.message.includes('Could not find the function');
  console.log(`[RPC Check] record_credit_ledger_entry_atomic: ${rpc2Found ? 'EXISTS' : 'ABSENT'}`);

  console.log('\n--- VERIFICATION SUMMARY ---');
  console.log(`Present Tables: ${presentCount} / ${tables.length}`);
  console.log(`Missing Tables: ${missingCount} / ${tables.length}`);

  return { missingCount, presentCount };
}

verifyRemoteDbState();
