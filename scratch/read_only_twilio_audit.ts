import fs from 'fs';
import path from 'path';
import twilio from 'twilio';

// Load .env.local manually
try {
  const envPath = path.join(process.cwd(), '.env.local');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...vals] = trimmed.split('=');
        const val = vals.join('=').trim().replace(/^["']|["']$/g, '');
        if (key && !process.env[key.trim()]) {
          process.env[key.trim()] = val;
        }
      }
    }
  }
} catch (e) {
  console.warn('Could not read .env.local:', e);
}

async function main() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const apiKeySid = process.env.TWILIO_API_KEY_SID?.trim();
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET?.trim();

  if (!accountSid || !apiKeySid || !apiKeySecret) {
    console.error('Missing Twilio env credentials:');
    console.error(`TWILIO_ACCOUNT_SID: ${accountSid ? 'SET' : 'MISSING'}`);
    console.error(`TWILIO_API_KEY_SID: ${apiKeySid ? 'SET' : 'MISSING'}`);
    console.error(`TWILIO_API_KEY_SECRET: ${apiKeySecret ? 'SET' : 'MISSING'}`);
    process.exit(1);
  }

  const client = twilio(apiKeySid, apiKeySecret, { accountSid });

  console.log('Fetching available phone number countries from Twilio...');
  try {
    const countries = await client.availablePhoneNumbers.list({ limit: 300 });
    console.log(`\n==================================================`);
    console.log(`TOTAL COUNTRIES EXPOSED TO THIS TWILIO ACCOUNT: ${countries.length}`);
    console.log(`==================================================\n`);

    const resultList: Array<{
      isoCode: string;
      countryName: string;
      beta: boolean;
      types: string[];
    }> = [];

    for (const c of countries) {
      const types: string[] = [];
      const sub = (c as any).subresourceUris || {};
      if (sub.local) types.push('local');
      if (sub.mobile) types.push('mobile');
      if (sub.toll_free) types.push('toll_free');
      if (sub.national) types.push('national');
      if (sub.shared_cost) types.push('shared_cost');
      if (sub.machine_to_machine) types.push('machine_to_machine');

      resultList.push({
        isoCode: c.countryCode,
        countryName: c.country,
        beta: (c as any).beta ?? false,
        types,
      });
    }

    console.log('COUNTRY LIST AND EXPOSED TYPES:');
    console.log(JSON.stringify(resultList, null, 2));

    // Audit Regulations for sample countries
    console.log('\n==================================================');
    console.log('AUDITING TWILIO REGULATIONS FOR SAMPLE COUNTRIES');
    console.log('==================================================\n');

    const sampleQueries = [
      { country: 'AU', type: 'local', endUserType: 'business' },
      { country: 'AU', type: 'local', endUserType: 'individual' },
      { country: 'NZ', type: 'local', endUserType: 'business' },
      { country: 'US', type: 'local', endUserType: 'business' },
      { country: 'GB', type: 'local', endUserType: 'business' },
      { country: 'DE', type: 'local', endUserType: 'business' },
      { country: 'CA', type: 'local', endUserType: 'business' },
    ];

    for (const q of sampleQueries) {
      try {
        const regs = await client.numbers.v2.regulatoryCompliance.regulations.list({
          isoCountry: q.country,
          numberType: q.type,
          endUserType: q.endUserType as any,
        } as any);

        console.log(`\nRegulation query for ${q.country} / ${q.type} / ${q.endUserType}: found ${regs.length} regulation(s)`);
        for (const reg of regs) {
          console.log(`  Regulation SID: ${reg.sid}, FriendlyName: ${reg.friendlyName}`);
          
          // Fetch detailed regulation
          const detail: any = await client.numbers.v2.regulatoryCompliance.regulations(reg.sid).fetch();
          console.log(`  EndUser Requirements:`, JSON.stringify(detail.endUserRequirements, null, 2));
          console.log(`  Supporting Document Requirements:`, JSON.stringify(detail.supportingDocumentRequirements, null, 2));
        }
      } catch (err: any) {
        console.error(`  Failed to query regulations for ${q.country}/${q.type}/${q.endUserType}:`, err.message);
      }
    }

  } catch (err: any) {
    console.error('Failed to list countries:', err.message);
  }
}

main();
