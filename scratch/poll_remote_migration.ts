(globalThis as any).WebSocket = class {};
import fs from 'fs';
import path from 'path';

const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of envContent.split('\n')) {
    const line = rawLine.trim();
    if (line && !line.startsWith('#') && line.includes('=')) {
      const idx = line.indexOf('=');
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && !process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

async function poll() {
  console.log('Polling remote Supabase project jupwsumuutuysmpxdtpw for newly created tables...');
  for (let i = 1; i <= 10; i++) {
    const res = await fetch(`${supabaseUrl}/rest/v1/?t=${Date.now()}`, {
      headers: {
        apikey: supabaseKey!,
        Authorization: `Bearer ${supabaseKey!}`,
        'Cache-Control': 'no-cache',
      },
    });
    if (res.ok) {
      const json = await res.json();
      const defs = Object.keys(json.paths || {});
      const hasMedia = defs.includes('/tenant_media_assets');
      const hasAudio = defs.includes('/number_audio_settings');
      console.log(`[Attempt ${i}/10] tenant_media_assets: ${hasMedia ? 'DETECTED' : 'MISSING'}, number_audio_settings: ${hasAudio ? 'DETECTED' : 'MISSING'}`);
      if (hasMedia && hasAudio) {
        console.log('SUCCESS! Migration objects detected in remote schema.');
        process.exit(0);
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log('Polling finished. Objects not yet detected.');
}

poll().catch(console.error);
