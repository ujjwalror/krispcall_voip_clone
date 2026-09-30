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

import { getExperimentKeyVersion } from '../src/lib/telephony/experimentCrypto';

function checkLocalKeyVersion() {
  const rawSecret = process.env.TELECOM_EXPERIMENT_HMAC_KEY;
  if (!rawSecret) {
    console.error('TELECOM_EXPERIMENT_HMAC_KEY is missing in process.env');
    process.exit(1);
  }

  const version = getExperimentKeyVersion(rawSecret);
  console.log('LOCAL_KEY_VERSION:', version);
}

checkLocalKeyVersion();
