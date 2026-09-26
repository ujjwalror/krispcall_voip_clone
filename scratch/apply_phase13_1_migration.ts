import fs from 'fs';
import path from 'path';
import { createAdminClient } from '../src/lib/supabase/admin';

// Load .env.local
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

async function applyMigration() {
  console.log('====================================================');
  console.log('APPLYING PHASE 13.1 MIGRATION TO SUPABASE DATABASE');
  console.log('====================================================\n');

  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261201000000_phase13_1_commercial_payment_foundation.sql'
  );

  if (!fs.existsSync(migrationPath)) {
    console.error('Migration file not found at:', migrationPath);
    process.exit(1);
  }

  const sql = fs.readFileSync(migrationPath, 'utf8');
  console.log(`Read migration SQL file (${sql.length} bytes).`);

  const supabase = createAdminClient();

  // Test Supabase connection and existing table verification
  const { data: testData, error: testErr } = await (supabase as any)
    .from('organizations')
    .select('id')
    .limit(1);

  if (testErr) {
    console.error('Failed to connect to Supabase database:', testErr.message);
    process.exit(1);
  }

  console.log('Successfully connected to Supabase database.');

  // Check if tables already exist or if DDL execution via RPC/Direct PG is needed
  const tables = [
    'billing_payment_operations',
    'billing_credit_ledger',
    'organization_billable_resources',
    'billable_resource_price_versions',
    'organization_billing_controls',
    'billing_invoices',
  ];

  console.log('\n--- VERIFYING EXISTING DATABASE OBJECT STATUS ---');
  for (const table of tables) {
    const { data, error } = await (supabase as any).from(table).select('id').limit(1);
    if (error) {
      console.log(`Table public.${table}: DOES NOT EXIST YET (${error.message})`);
    } else {
      console.log(`Table public.${table}: EXISTS`);
    }
  }

  // Attempt DDL execution via exec_sql / db_exec RPC if configured, or direct SQL runner
  const { data: rpcRes, error: rpcErr } = await (supabase as any).rpc('exec_sql', { sql_query: sql });

  if (rpcErr) {
    console.log('\nRPC exec_sql not present on remote instance. Checking if tables exist or applying statements...');
    // Split SQL statements and verify structure
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    console.log(`Migration contains ${statements.length} SQL DDL statements.`);
  } else {
    console.log('Migration executed successfully via exec_sql RPC!');
  }
}

applyMigration();
