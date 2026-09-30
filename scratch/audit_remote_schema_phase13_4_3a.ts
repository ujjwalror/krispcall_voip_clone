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

async function checkColumnsDetailed() {
  const columnsToCheck = [
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

  console.log('--- Checking billing_invoices columns individually ---');
  for (const col of columnsToCheck) {
    const res = await fetch(`${supabaseUrl}/rest/v1/billing_invoices?select=${col}&limit=1`, { method: 'GET', headers });
    if (res.ok) {
      console.log(`  [PRESENT] column billing_invoices.${col}`);
    } else {
      console.log(`  [ABSENT ] column billing_invoices.${col}`);
    }
  }

  console.log('\n--- Checking billing_invoices constraints & indexes ---');
  const resBase = await fetch(`${supabaseUrl}/rest/v1/billing_invoices?select=id,organization_id,provider,provider_invoice_id,status,currency,amount_due_minor,amount_paid_minor&limit=1`, { method: 'GET', headers });
  console.log('  Base billing_invoices accessible:', resBase.ok);

  console.log('\n--- Checking functions ---');
  const funcs = ['fn_enforce_invoice_line_immutability', 'fn_enforce_invoice_header_immutability', 'reconcile_stripe_invoice_atomic'];
  for (const fn of funcs) {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify({}) });
    const text = await res.text();
    if (res.status === 404 || text.includes('Could not find') || text.includes('PGRST202')) {
      console.log(`  [ABSENT ] function ${fn}`);
    } else {
      console.log(`  [PRESENT] function ${fn}`);
    }
  }
}

checkColumnsDetailed().catch(console.error);
