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

async function inspectVercelDeployment() {
  const domain = 'https://krispcall-voip-clone-udlg.vercel.app';

  console.log(`Polling production domain: ${domain}...`);

  try {
    const res = await fetch(domain, { method: 'HEAD' });
    console.log('Production Domain Status:', res.status, res.statusText);
    console.log('Headers:');
    res.headers.forEach((val, key) => {
      if (key.includes('vercel') || key.includes('x-') || key === 'server' || key === 'date') {
        console.log(`  ${key}: ${val}`);
      }
    });

    console.log('\nPolling /api/twilio/health on production...');
    const healthRes = await fetch(`${domain}/api/twilio/health`);
    console.log('Health Endpoint Status:', healthRes.status);
    const healthJson = await healthRes.json().catch(() => null);
    console.log('Health Output:', healthJson);
  } catch (err) {
    console.error('Error fetching production domain:', err);
  }
}

inspectVercelDeployment().catch(console.error);
