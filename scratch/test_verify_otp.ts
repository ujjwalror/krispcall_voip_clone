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

import { createClient } from '@supabase/supabase-js';
import { createAdminClient } from '../src/lib/supabase/admin';

async function verifyOtpAndGetToken() {
  const adminSupabase = createAdminClient();
  const linkRes = await adminSupabase.auth.admin.generateLink({
    type: 'magiclink',
    email: 'ujjwalror4141@gmail.com',
  });

  if (!linkRes.data.properties?.email_otp) {
    console.error('Failed to get email_otp');
    process.exit(1);
  }

  const token = linkRes.data.properties.email_otp;
  console.log('Got OTP:', token);

  const anonSupabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false } }
  );

  const { data, error } = await anonSupabase.auth.verifyOtp({
    email: 'ujjwalror4141@gmail.com',
    token: token,
    type: 'magiclink',
  });

  console.log('Verify OTP Result:', error ? error.message : 'SUCCESS');
  if (data.session) {
    console.log('Got access_token:', data.session.access_token.slice(0, 30) + '...');
    
    // Query production endpoint
    const domain = 'https://krispcall-voip-clone-udlg.vercel.app';
    const url = `${domain}/api/admin/telecom-experiment-diagnostic`;
    console.log(`Polling production endpoint: ${url}...`);

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${data.session.access_token}`,
        'Cookie': `sb-access-token=${data.session.access_token}; sb-refresh-token=${data.session.refresh_token}`,
      },
    });

    console.log('Production Endpoint Response Status:', res.status, res.statusText);
    res.headers.forEach((val, key) => {
      console.log(`  header ${key}: ${val}`);
    });

    const text = await res.text();
    console.log('Response Body Text (first 200 chars):', text.slice(0, 200));
  }
}

verifyOtpAndGetToken().catch(console.error);
