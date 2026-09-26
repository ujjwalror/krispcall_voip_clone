import fs from 'fs';
import path from 'path';

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

import { createAdminClient } from '../src/lib/supabase/admin';

async function checkOrgSchema() {
  const supabase = createAdminClient();
  const { data, error } = await (supabase as any)
    .from('organizations')
    .select('*')
    .limit(1);

  console.log('Organizations data sample:', data);
  console.log('Organizations error:', error);
}

checkOrgSchema().catch(console.error);
