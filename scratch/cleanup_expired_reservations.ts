import fs from 'fs';
import path from 'path';
(globalThis as any).WebSocket = class {};
import { createClient } from '@supabase/supabase-js';

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

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

async function cleanupExpiredReservations() {
  const orgId = '00000000-0000-0000-0000-000000000001';
  console.log('--- Cleaning up expired reservations for org ---');

  const { data: expiredRes, error } = await supabase
    .from('telecom_usage_reservations')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .eq('organization_id', orgId)
    .eq('status', 'active')
    .lt('expires_at', new Date().toISOString())
    .select();

  console.log('Expired reservations updated:', expiredRes, 'Error:', error);
}

cleanupExpiredReservations().catch(console.error);
