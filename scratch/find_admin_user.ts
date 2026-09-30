import fs from 'fs';
import path from 'path';

const envPath = path.resolve('.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.substring(0, idx).trim();
      const val = trimmed.substring(idx + 1).trim().replace(/^["']|["']$/g, '');
      process.env[key] = val;
    }
  }
}

import { createAdminClient } from '../src/lib/supabase/admin';

async function findAdminUser() {
  const supabase = createAdminClient();

  const { data: members, error: memErr } = await supabase
    .from('organization_members')
    .select('user_id, role, organization_id')
    .in('role', ['owner', 'admin'])
    .limit(5);

  console.log('Org Members (owner/admin):', members, 'Error:', memErr?.message);

  const { data: users, error: userErr } = await supabase.auth.admin.listUsers();
  console.log('Auth Users Count:', users?.users.length);
  if (users?.users.length) {
    console.log('First user:', users.users[0].id, users.users[0].email);
  }
}

findAdminUser().catch(console.error);
