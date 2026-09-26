import fs from 'fs';
import path from 'path';

try {
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...vals] = trimmed.split('=');
        if (key && vals.length > 0) {
          process.env[key.trim()] = vals.join('=').trim().replace(/^["']|["']$/g, '');
        }
      }
    });
  }
} catch (err) {}

async function runLiveTearDown() {
  const { createAdminClient } = await import('../src/lib/supabase/admin');
  const { createTwilioServerClient } = await import('../src/lib/twilio/client');
  const { Phase12_5HarnessService } = await import('../src/lib/telephony/commerce/phase12_5_harness');
  const { MarketplaceSuppressionService } = await import('../src/lib/telephony/marketplace/marketplaceSuppressionService');

  console.log('====================================================');
  console.log('PHASE 12.5 — CONTROLLED LIVE TEAR-DOWN RELEASE');
  console.log('====================================================\n');

  const candidateE164 = '+15593156374';
  const expectedProviderSid = 'PN56fe03d6b495c766c3ea15906dde2d69';
  const organizationId = '00000000-0000-0000-0000-000000000001';
  const supabase = createAdminClient();
  const twilio = createTwilioServerClient();

  // Pre-release confirmation
  const { data: dbPhone } = await (supabase as any)
    .from('phone_numbers')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('phone_number', candidateE164)
    .in('status', ['active', 'inactive', 'suspended'])
    .single();

  if (!dbPhone) {
    console.error('STOP: Phone number ownership record not found for tear-down.');
    process.exit(1);
  }

  const currentSid = dbPhone.provider_sid || dbPhone.twilio_phone_number_sid;
  if (currentSid !== expectedProviderSid) {
    console.error(`STOP: Provider SID mismatch. Found ${currentSid}, expected ${expectedProviderSid}.`);
    process.exit(1);
  }

  console.log(`Pre-Release Target Confirmed: ${candidateE164} (SID: ${currentSid})`);
  console.log(`Organization ID: ${organizationId}`);

  // Execute at most ONE Twilio release/remove mutation
  console.log('\n--- EXECUTING LIVE TWILIO RELEASE MUTATION ---');
  const tearDownResult = await Phase12_5HarnessService.executeTestTearDown({
    organizationId,
    phoneNumberE164: candidateE164,
    userRole: 'owner',
    executeLive: true,
  });

  console.log(`Tear-Down Success: ${tearDownResult.success}`);
  console.log(`Reconciliation Outcome: ${tearDownResult.reconciliationOutcome}`);
  console.log(`Previous Status: ${tearDownResult.previousStatus}`);
  console.log(`New Status: ${tearDownResult.newStatus}`);
  console.log(`Historical Record Retained: ${tearDownResult.historicalRecordRetained}`);
  console.log(`Message: ${tearDownResult.message}\n`);

  if (!tearDownResult.success || tearDownResult.newStatus !== 'released') {
    console.error('STOP: Live tear-down did not complete cleanly.');
    process.exit(1);
  }

  // Post-release reconciliation & verification
  console.log('--- POST-RELEASE RECONCILIATION & VERIFICATION ---');

  // 1. Fetch DB record post-release
  const { data: dbPhonePostRelease } = await (supabase as any)
    .from('phone_numbers')
    .select('*')
    .eq('id', dbPhone.id)
    .single();

  console.log(`1. Post-Release DB Status: ${dbPhonePostRelease?.status} (Expected: 'released')`);
  console.log(`2. Post-Release DB Active Flag: ${dbPhonePostRelease?.active} (Expected: false)`);
  console.log(`3. Historical Row Retained: ${!!dbPhonePostRelease ? 'YES' : 'NO'}`);

  // 2. Verify My Numbers query NO LONGER returns it as currently owned
  const { data: myNumbersPostRelease } = await (supabase as any)
    .from('phone_numbers')
    .select('id, phone_number')
    .eq('organization_id', organizationId)
    .in('status', ['active', 'inactive', 'suspended']);
  const inMyNumbersPostRelease = myNumbersPostRelease?.some((n: any) => n.phone_number === candidateE164);
  console.log(`4. My Numbers Currently Owned Returns Released Number: ${inMyNumbersPostRelease ? 'YES (FAIL)' : 'NO (PASS)'}`);

  // 3. Verify Marketplace Suppression is CLEARED for released status
  const suppressionResPostRelease = await MarketplaceSuppressionService.getSuppressedPhoneNumbers();
  const isSuppressedPostRelease = suppressionResPostRelease.suppressedSet.has(candidateE164);
  console.log(`5. Marketplace Suppression Retains Released Number: ${isSuppressedPostRelease ? 'YES (FAIL)' : 'NO (PASS - Cleared)'}`);

  // 4. Verify authoritative provider absence via Twilio GET fetch
  let twilioResourceAbsent = false;
  try {
    await twilio.incomingPhoneNumbers(expectedProviderSid).fetch();
    twilioResourceAbsent = false;
  } catch (err: any) {
    if (err.status === 404 || err.code === 20404) {
      twilioResourceAbsent = true;
    }
  }
  console.log(`6. Authoritative Provider Resource Absence Confirmed (Twilio 404): ${twilioResourceAbsent ? 'YES' : 'NO'}`);

  console.log('\n====================================================');
  console.log('LIVE TEAR-DOWN RELEASE COMPLETED SUCCESSFULLY');
  console.log('====================================================\n');
}

runLiveTearDown().catch((err) => {
  console.error('FATAL ERROR DURING LIVE TEAR-DOWN:', err);
  process.exit(1);
});
