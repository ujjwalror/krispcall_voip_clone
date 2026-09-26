import Module from 'module';
import path from 'path';
import fs from 'fs';

// Load .env.local if present
const envLocalPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envLocalPath)) {
  const envConfig = fs.readFileSync(envLocalPath, 'utf8');
  envConfig.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  });
}

const projectRoot = path.resolve(__dirname, '..');
const originalRequire = (Module.prototype as any).require;
(Module.prototype as any).require = function (id: string) {
  if (id === 'server-only') {
    return {};
  }
  if (id.startsWith('@/')) {
    const resolvedPath = path.join(projectRoot, 'src', id.slice(2));
    return originalRequire.call(this, resolvedPath);
  }
  return originalRequire.apply(this, arguments);
};

const { createTwilioServerClient } = require('../src/lib/twilio/client');
const { RegulatoryPreCheckService } = require('../src/lib/telephony/marketplace/regulatoryPreCheckService');

async function runDiscovery() {
  console.log('=== PHASE 11.4B READ-ONLY REGULATORY DISCOVERY ===');
  
  const client = createTwilioServerClient();
  const regList = await client.numbers.v2.regulatoryCompliance.regulations.list({
    isoCountry: 'AU',
    numberType: 'local',
    endUserType: 'business',
  });

  console.log(`Found ${regList.length} regulations for AU local business:`);
  regList.forEach((r: any, idx: number) => {
    console.log(`\n--- Regulation #${idx + 1} ---`);
    console.log('SID:', r.sid);
    console.log('Friendly Name:', r.friendlyName);
    console.log('ISO Country:', r.isoCountry);
    console.log('Number Type:', r.numberType);
    console.log('End User Type:', r.endUserType);
    console.log('Requirements:', JSON.stringify(r.requirements, null, 2));
  });

  const precheck = await RegulatoryPreCheckService.evaluateRequirements('AU', 'local', 'business');
  console.log('\n==================================================');
  console.log('NORMALIZED PRECHECK EVALUATION RESULT:');
  console.log('==================================================');
  console.log(JSON.stringify(precheck, null, 2));
}

runDiscovery().catch(err => {
  console.error('Discovery Failed:', err);
  process.exit(1);
});
