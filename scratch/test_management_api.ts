import fs from 'fs';
import path from 'path';

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

async function testManagementApi() {
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  const projectRef = 'jupwsumuutuysmpxdtpw';

  console.log('Testing Supabase Management API...');
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secretKey}`,
    },
    body: JSON.stringify({ query: 'SELECT 1;' }),
  });

  console.log('Management API response status:', res.status);
  const text = await res.text();
  console.log('Management API response text:', text);
}

testManagementApi();
