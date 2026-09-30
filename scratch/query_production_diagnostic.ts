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

async function queryProductionDiagnostic() {
  const domain = 'https://krispcall-voip-clone-udlg.vercel.app';
  console.log(`=== QUERYING PRODUCTION DIAGNOSTIC ON ${domain} ===\n`);

  const supabase = createAdminClient();

  // 1. Target owner profile: ujjwalror4141@gmail.com (id: 01598226-79ff-4976-b769-821b8a69e30b)
  const targetUserId = '01598226-79ff-4976-b769-821b8a69e30b';
  console.log('Target Owner User ID:', targetUserId);

  // 2. Generate custom session access token for this owner user using Supabase auth admin
  const { data: sessionData, error: sessionErr } = await supabase.auth.admin.createSession({
    user_id: targetUserId,
  });

  if (sessionErr || !sessionData.session) {
    console.error('Failed to create admin session:', sessionErr?.message);
    process.exit(1);
  }

  const accessToken = sessionData.session.access_token;
  console.log('✓ Successfully generated server-authenticated owner access token.');

  // 3. Query production diagnostic endpoint
  const url = `${domain}/api/admin/telecom-experiment-diagnostic`;
  console.log(`Polling production endpoint: ${url}...`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Cookie': `sb-access-token=${accessToken}; sb-refresh-token=${sessionData.session.refresh_token}`,
    },
  });

  console.log('Response Status:', response.status, response.statusText);
  const json = await response.json();
  console.log('Production Diagnostic Response Payload:', json);

  if (response.status === 200 && json.experimentKeyVersion) {
    console.log('\n====================================================');
    console.log(`PRODUCTION_KEY_VERSION = ${json.experimentKeyVersion}`);
    console.log('====================================================');
  } else {
    console.error('❌ Failed to retrieve valid key version from production endpoint.');
  }
}

queryProductionDiagnostic().catch(console.error);
