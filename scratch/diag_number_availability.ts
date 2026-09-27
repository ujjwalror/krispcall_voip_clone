import fs from 'fs';
import path from 'path';

// Load .env.local variables if not already present
if (!process.env.TWILIO_ACCOUNT_SID) {
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
}

import { inventoryProvider } from '../src/lib/telephony/marketplace/inventoryProvider';

async function runDiagnostic() {
  console.log('==================================================');
  console.log('DIAGNOSTIC: EXACT NUMBER AVAILABILITY RECHECK');
  console.log('==================================================\n');

  // 1. Fetch fresh marketplace inventory for US local
  console.log('1. Fetching fresh US local marketplace inventory...');
  const usNumbers = await inventoryProvider.searchAvailableNumbers({
    countryCode: 'US',
    numberType: 'local',
    limit: 10,
  });

  console.log(`Discovered ${usNumbers.length} US local numbers.`);
  if (usNumbers.length === 0) {
    console.log('No US local numbers returned by provider.');
    return;
  }

  const sampleCandidate = usNumbers[0];
  console.log(`Sample Candidate: ${sampleCandidate.phoneNumber} (${sampleCandidate.friendlyDisplay})`);

  // 2. Test Checkout Recheck WITHOUT 'contains' filter (current buggy implementation)
  console.log('\n2. Testing Checkout Recheck WITHOUT contains filter (limit 20 random numbers)...');
  const randomPage = await inventoryProvider.searchAvailableNumbers({
    countryCode: 'US',
    numberType: 'local',
    limit: 20,
  });

  const foundInRandom = randomPage.some((item) => item.phoneNumber === sampleCandidate.phoneNumber);
  console.log(`Candidate found in 20 random numbers? ${foundInRandom ? 'YES' : 'NO'}`);

  // 3. Test Checkout Recheck WITH 'contains' filter (exact number target)
  console.log('\n3. Testing Checkout Recheck WITH contains filter...');
  const exactSearchWithE164 = await inventoryProvider.searchAvailableNumbers({
    countryCode: 'US',
    numberType: 'local',
    contains: sampleCandidate.phoneNumber,
    limit: 10,
  });

  const foundWithE164 = exactSearchWithE164.some(
    (item) => item.phoneNumber === sampleCandidate.phoneNumber || item.phoneNumber.replace(/[^0-9]/g, '').endsWith(sampleCandidate.phoneNumber.replace(/[^0-9]/g, ''))
  );
  console.log(`Candidate found using contains with full E.164 (${sampleCandidate.phoneNumber})? ${foundWithE164 ? 'YES' : 'NO'} (returned ${exactSearchWithE164.length} items)`);

  // 4. Test with digits-only contains filter (e.g. stripping '+')
  const digitsOnly = sampleCandidate.phoneNumber.replace(/[^0-9]/g, '');
  console.log(`\n4. Testing Checkout Recheck with digits-only contains filter (${digitsOnly})...`);
  const exactSearchDigits = await inventoryProvider.searchAvailableNumbers({
    countryCode: 'US',
    numberType: 'local',
    contains: digitsOnly,
    limit: 10,
  });

  const foundDigits = exactSearchDigits.some(
    (item) => item.phoneNumber === sampleCandidate.phoneNumber || item.phoneNumber.replace(/[^0-9]/g, '') === digitsOnly
  );
  console.log(`Candidate found using contains with digits-only (${digitsOnly})? ${foundDigits ? 'YES' : 'NO'} (returned ${exactSearchDigits.length} items)`);

  // 5. Test AU local numbers (Australian category)
  console.log('\n5. Fetching fresh AU local marketplace inventory...');
  const auNumbers = await inventoryProvider.searchAvailableNumbers({
    countryCode: 'AU',
    numberType: 'local',
    limit: 10,
  });

  if (auNumbers.length > 0) {
    const auCandidate = auNumbers[0];
    console.log(`AU Candidate: ${auCandidate.phoneNumber}`);

    const auRandomPage = await inventoryProvider.searchAvailableNumbers({
      countryCode: 'AU',
      numberType: 'local',
      limit: 20,
    });
    const foundAuRandom = auRandomPage.some((item) => item.phoneNumber === auCandidate.phoneNumber);
    console.log(`AU Candidate found in 20 random numbers? ${foundAuRandom ? 'YES' : 'NO'}`);

    const auDigitsOnly = auCandidate.phoneNumber.replace(/[^0-9]/g, '');
    const auExactSearch = await inventoryProvider.searchAvailableNumbers({
      countryCode: 'AU',
      numberType: 'local',
      contains: auDigitsOnly,
      limit: 10,
    });
    const foundAuExact = auExactSearch.some(
      (item) => item.phoneNumber === auCandidate.phoneNumber || item.phoneNumber.replace(/[^0-9]/g, '') === auDigitsOnly
    );
    console.log(`AU Candidate found using contains digits-only? ${foundAuExact ? 'YES' : 'NO'} (returned ${auExactSearch.length} items)`);
  }

  console.log('\n==================================================');
  console.log('DIAGNOSTIC COMPLETED');
  console.log('==================================================');
}

runDiagnostic().catch((err) => {
  console.error('Diagnostic error:', err);
});
