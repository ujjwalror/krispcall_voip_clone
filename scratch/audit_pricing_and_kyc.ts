import fs from 'fs';
import path from 'path';

// Load .env.local variables into process.env if present
try {
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...valParts] = trimmed.split('=');
        const val = valParts.join('=').replace(/^["']|["']$/g, '');
        if (key && !process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
} catch (e) {
  console.warn('Failed to parse .env.local:', e);
}

import { createAdminClient } from '../src/lib/supabase/admin';

async function auditDB() {
  const supabase = createAdminClient();

  console.log('=== AUDITING PHONE NUMBER RETAIL PRICES (EXPLICIT OVERRIDES) ===');
  const { data: overrides, error: overrideErr } = await (supabase as any)
    .from('phone_number_retail_prices')
    .select('*');
  console.log('Overrides:', overrideErr ? overrideErr.message : overrides);

  console.log('\n=== AUDITING PHONE NUMBER PRICING POLICIES ===');
  const { data: policies, error: policyErr } = await (supabase as any)
    .from('phone_number_pricing_policies')
    .select('*');
  console.log('Policies:', policyErr ? policyErr.message : policies);
}

auditDB();
