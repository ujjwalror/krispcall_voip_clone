import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Load .env.local
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

async function auditPrereqMigration() {
  console.log('====================================================');
  console.log('AUDITING PHASE 13.3.1 PREREQUISITE MIGRATION');
  console.log('====================================================\n');

  const fileRelPath = 'supabase/migrations/20261202000000_phase13_3_commercial_saga.sql';
  const filePath = path.resolve(process.cwd(), fileRelPath);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Migration file not found at ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const buffer = fs.readFileSync(filePath);

  const bytes = buffer.length;
  const lines = content.split('\n').length;
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  console.log(`File Path: ${fileRelPath}`);
  console.log(`Byte Size: ${bytes} bytes`);
  console.log(`Line Count: ${lines} lines`);
  console.log(`SHA-256 Checksum: ${sha256}`);

  // Remote dependency check
  console.log('\n--- REMOTE DEPENDENCY CHECK (project jupwsumuutuysmpxdtpw) ---');
  const supabase = createAdminClient();

  const dependencies = [
    'organizations',
    'billing_payment_operations',
    'provider_number_operations',
    'profiles',
  ];

  for (const dep of dependencies) {
    const { data, error } = await (supabase as any).from(dep).select('id').limit(1);
    if (error) {
      console.error(`❌ Missing dependency table: public.${dep} (${error.message})`);
    } else {
      console.log(`✓ Dependency table public.${dep} exists remotely.`);
    }
  }
}

auditPrereqMigration().catch((err) => {
  console.error('Fatal error during prerequisite audit:', err);
  process.exit(1);
});
