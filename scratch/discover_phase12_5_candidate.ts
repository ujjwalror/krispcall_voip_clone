import fs from 'fs';
import path from 'path';

// Parse .env.local manually
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
} catch (err) {
  // Ignore error if env file missing
}

import { createTwilioServerClient } from '../src/lib/twilio/client';
import { ProviderCostService } from '../src/lib/telephony/marketplace/providerCostService';
import { RetailPricingService } from '../src/lib/telephony/marketplace/pricingService';
import { RegulatoryPreCheckService } from '../src/lib/telephony/marketplace/regulatoryPreCheckService';

async function discoverCandidate() {
  console.log('====================================================');
  console.log('SAFE READ-ONLY DISCOVERY FOR PHASE 12.5 CANDIDATE');
  console.log('====================================================\n');

  try {
    const client = createTwilioServerClient();

    // 1. Fetch available US Local numbers from Twilio
    const available = await client.availablePhoneNumbers('US').local.list({ limit: 3 });

    if (!available || available.length === 0) {
      console.log('No US local numbers available in live inventory search.');
      return;
    }

    const candidate = available[0];
    const e164 = candidate.phoneNumber;

    console.log(`Discovered Candidate E.164: ${e164}`);
    console.log(`Friendly Display: ${candidate.friendlyName}`);
    console.log(`Locality: ${candidate.locality}, Region: ${candidate.region}`);
    console.log(`Capabilities: Voice=${candidate.capabilities.voice}, SMS=${candidate.capabilities.sms}, MMS=${candidate.capabilities.mms}`);

    // 2. Fetch Provider Wholesale Cost
    const costRes = await ProviderCostService.getProviderCost('US');
    const localCost = costRes.prices.find((p) => p.numberType === 'local');

    console.log(`\nProvider Wholesale Cost: ${localCost?.currentPriceFormatted} (${localCost?.currentPriceMinor}¢)`);
    console.log(`Provider Currency: ${costRes.currency}`);

    // 3. Resolve Retail Price under Phase 12.4 Policy
    const retailRes = await RetailPricingService.resolveRetailPrice('US', 'local', 'USD');
    console.log(`Retail Price under Policy: ${retailRes.monthlyPriceFormatted} (${retailRes.monthlyPriceMinor}¢)`);

    // 4. Regulatory Requirements Check
    const regCheck = await RegulatoryPreCheckService.evaluateRequirements('US', 'local', 'business');
    console.log(`\nRegulatory Requirements Status: ${regCheck.status}`);
    console.log(`Bundle Required: ${regCheck.bundleRequired}`);
    console.log(`End-User Requirements Count: ${regCheck.endUserRequirements.length}`);
    console.log(`Supporting Document Requirements Count: ${regCheck.supportingDocumentRequirements.length}`);
    console.log(`Message: "${regCheck.message}"`);

    console.log('\n====================================================');
  } catch (err: any) {
    console.error('Discovery error:', err.message || err);
  }
}

discoverCandidate();
