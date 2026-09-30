import fs from 'fs';
import path from 'path';

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

async function checkStatus() {
  const supabase = createAdminClient();

  console.log('--- PRE-DEPLOYMENT SAFETY CHECK ---');
  console.log('Project Ref Target: jupwsumuutuysmpxdtpw');
  console.log('NEXT_PUBLIC_SUPABASE_URL:', process.env.NEXT_PUBLIC_SUPABASE_URL);

  const { data: payOps, error: payOpErr } = await (supabase as any)
    .from('billing_payment_operations')
    .select('id, status')
    .limit(1);

  if (payOpErr) {
    console.error('billing_payment_operations table check error:', payOpErr.message);
  } else {
    console.log('✓ billing_payment_operations exists remotely.');
  }

  const { data: sagaData, error: sagaErr } = await (supabase as any)
    .from('commercial_number_purchase_sagas')
    .select('id')
    .limit(1);

  if (sagaErr && sagaErr.code === 'PGRST205') {
    console.log('ℹ️  Notice: public.commercial_number_purchase_sagas table is NOT yet in remote schema cache (requires 20261202000000 migration).');
  } else if (!sagaErr) {
    console.log('✓ public.commercial_number_purchase_sagas exists remotely.');
  }

  console.log('PHASE13_PAYMENT_ENABLED:', process.env.PHASE13_PAYMENT_ENABLED || 'false');
}

checkStatus();
