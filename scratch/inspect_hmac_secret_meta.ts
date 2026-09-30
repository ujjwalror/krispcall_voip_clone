import fs from 'fs';
import path from 'path';

const envPath = path.resolve(process.cwd(), '.env.local');
let rawKey = '';
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (key === 'TELECOM_EXPERIMENT_HMAC_KEY') {
        rawKey = val;
      }
    }
  }
}

console.log('=== TELECOM_EXPERIMENT_HMAC_KEY NON-SECRET METADATA ===');
console.log('Raw string length:', rawKey.length);
console.log('Trimmed string length:', rawKey.trim().length);
console.log('Has leading/trailing whitespace:', rawKey !== rawKey.trim());
console.log('Is 64 hex characters:', /^[a-fA-F0-9]{64}$/.test(rawKey.trim()));
console.log('Is valid base64 pattern:', /^[A-Za-z0-9+/=]+$/.test(rawKey.trim()));
console.log('Base64 length % 4 === 0:', rawKey.trim().length % 4 === 0);
