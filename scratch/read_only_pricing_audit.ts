import fs from 'fs';
import path from 'path';

// Load .env.local manually
try {
  const envPath = path.join(process.cwd(), '.env.local');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...vals] = trimmed.split('=');
        const val = vals.join('=').trim().replace(/^["']|["']$/g, '');
        if (key && !process.env[key.trim()]) {
          process.env[key.trim()] = val;
        }
      }
    }
  }
} catch (e) {
  console.warn('Could not read .env.local:', e);
}

import { createAdminClient } from '@/lib/supabase/admin';

async function main() {
  console.log('Querying public.phone_number_retail_prices...');
  try {
    const supabase = createAdminClient();
    const { data, error } = await (supabase as any)
      .from('phone_number_retail_prices')
      .select('*');

    if (error) {
      console.error('Database query error:', error.message);
      return;
    }

    console.log(`FOUND ${data ? data.length : 0} RETAIL PRICE ROWS IN DB:`);
    console.log(JSON.stringify(data, null, 2));
  } catch (err: any) {
    console.error('Failed to query database:', err.message || err);
  }
}

main();
