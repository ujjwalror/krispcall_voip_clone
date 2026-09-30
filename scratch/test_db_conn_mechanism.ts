import fs from 'fs';
import path from 'path';

// Load .env.local if present
try {
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf8');
    for (const line of envConfig.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...vals] = trimmed.split('=');
        if (key && !process.env[key.trim()]) {
          process.env[key.trim()] = vals.join('=').trim();
        }
      }
    }
  }
} catch (e) {}

import { createAdminClient } from '../src/lib/supabase/admin';

async function testConnection() {
  const dbUrl = process.env.DATABASE_URL || process.env.DIRECT_URL || process.env.POSTGRES_URL;
  console.log('Database URL available:', !!dbUrl);

  const supabase = createAdminClient();
  
  // Test if exec_sql RPC exists on Supabase admin client
  const { data, error } = await supabase.rpc('exec_sql', {
    query_text: `
      BEGIN;
      SELECT 1 as test_col;
      COMMIT;
    `
  });
  console.log('exec_sql test:', error ? `RPC error: ${error.message}` : data);
}

testConnection().catch(console.error);
