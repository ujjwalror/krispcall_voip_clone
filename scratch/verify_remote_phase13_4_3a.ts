import * as fs from 'fs';
import * as path from 'path';

// Parse .env.local manually
const envPath = path.resolve('.env.local');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      process.env[key] = val;
    }
  }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '';

const headers = {
  'apikey': supabaseKey,
  'Authorization': `Bearer ${supabaseKey}`,
  'Content-Type': 'application/json'
};

async function verifyRemotePostDeployment() {
  console.log('=== READ-ONLY REMOTE POST-DEPLOYMENT VERIFICATION (PHASE 13.4.3A) ===\n');

  // 1. Check billing_invoices columns
  console.log('1. Verifying billing_invoices columns...');
  const invCols = [
    'provider_customer_id',
    'provider_subscription_id',
    'subtotal_minor',
    'discount_minor',
    'tax_minor',
    'amount_remaining_minor',
    'provider_created_at',
    'finalized_at',
    'paid_at',
    'voided_at',
    'marked_uncollectible_at',
    'metadata'
  ];

  for (const col of invCols) {
    const res = await fetch(`${supabaseUrl}/rest/v1/billing_invoices?select=${col}&limit=1`, { method: 'GET', headers });
    if (res.ok) {
      console.log(`  ✅ [PRESENT] billing_invoices.${col}`);
    } else {
      console.log(`  ❌ [ABSENT ] billing_invoices.${col}`);
    }
  }

  // 2. Check billing_invoice_lines table and columns
  console.log('\n2. Verifying billing_invoice_lines table and columns...');
  const lineCols = [
    'id',
    'invoice_id',
    'provider_line_id',
    'description',
    'quantity',
    'unit_amount_minor',
    'unit_amount_decimal',
    'subtotal_minor',
    'amount_minor',
    'currency',
    'period_start',
    'period_end',
    'resource_type',
    'resource_id',
    'subscription_id',
    'price_version_id',
    'metadata',
    'created_at',
    'updated_at'
  ];

  for (const col of lineCols) {
    const res = await fetch(`${supabaseUrl}/rest/v1/billing_invoice_lines?select=${col}&limit=1`, { method: 'GET', headers });
    if (res.ok) {
      console.log(`  ✅ [PRESENT] billing_invoice_lines.${col}`);
    } else {
      console.log(`  ❌ [ABSENT ] billing_invoice_lines.${col}`);
    }
  }

  // 3. Verify RPC function existence & security permissions
  console.log('\n3. Verifying reconcile_stripe_invoice_atomic RPC function security & presence...');
  // Service role call:
  const serviceRes = await fetch(`${supabaseUrl}/rest/v1/rpc/reconcile_stripe_invoice_atomic`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      p_organization_id: '00000000-0000-0000-0000-000000000000',
      p_payload: { id: 'in_verify_test', customer: 'cus_test', status: 'draft', currency: 'USD', subtotal: 0, amount_due: 0, amount_paid: 0 }
    })
  });
  const serviceText = await serviceRes.text();
  console.log('  Service Role Call Response Status:', serviceRes.status);
  console.log('  Service Role Call Response Body:', serviceText);
  if (serviceText.includes('ORGANIZATION_NOT_FOUND')) {
    console.log('  ✅ reconcile_stripe_invoice_atomic function EXISTS and executed under service_role!');
  } else {
    console.log('  ⚠️ Service role response:', serviceText);
  }

  // Anon call (must be rejected):
  const anonHeaders = {
    'apikey': process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '',
    'Authorization': `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || ''}`,
    'Content-Type': 'application/json'
  };
  const anonRes = await fetch(`${supabaseUrl}/rest/v1/rpc/reconcile_stripe_invoice_atomic`, {
    method: 'POST',
    headers: anonHeaders,
    body: JSON.stringify({
      p_organization_id: '00000000-0000-0000-0000-000000000000',
      p_payload: { id: 'in_verify_test', customer: 'cus_test', status: 'draft', currency: 'USD', subtotal: 0, amount_due: 0, amount_paid: 0 }
    })
  });
  const anonText = await anonRes.text();
  console.log('  Anon Call Response Status:', anonRes.status);
  console.log('  Anon Call Response Body:', anonText);
  if (anonRes.status === 401 || anonRes.status === 403 || anonText.includes('permission denied') || anonText.includes('PGRST301') || anonText.includes('PGRST202')) {
    console.log('  ✅ Anon execution BLOCKED cleanly!');
  } else {
    console.log('  ❌ WARNING: Anon execution was NOT blocked:', anonRes.status);
  }

  // 4. Verify RLS policy for authenticated on billing_invoice_lines
  console.log('\n4. Verifying billing_invoice_lines RLS policy for authenticated / anon...');
  const anonLineRes = await fetch(`${supabaseUrl}/rest/v1/billing_invoice_lines?select=id`, { method: 'GET', headers: anonHeaders });
  console.log('  Anon line select status:', anonLineRes.status);
  const anonLineText = await anonLineRes.text();
  console.log('  Anon line select body:', anonLineText);
}

verifyRemotePostDeployment().catch(console.error);
