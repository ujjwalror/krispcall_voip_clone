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

async function testSqlEndpoint() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;

  console.log('Testing Supabase REST SQL endpoints...');
  const res = await fetch(`${supabaseUrl}/rest/v1/`, {
    headers: {
      apikey: serviceKey!,
      Authorization: `Bearer ${serviceKey}`,
    },
  });
  console.log('REST Root Status:', res.status);
}

testSqlEndpoint();
