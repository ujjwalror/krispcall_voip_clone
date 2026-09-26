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

import { createAdminClient } from '../src/lib/supabase/admin';
import { RetailPricingService } from '../src/lib/telephony/marketplace/pricingService';
import { ProviderCostService } from '../src/lib/telephony/marketplace/providerCostService';

async function verifyRemoteConfig() {
  console.log('====================================================');
  console.log('PHASE 12.4 POST-MIGRATION REMOTE VERIFICATION');
  console.log('====================================================\n');

  const supabase = createAdminClient();

  // 1. Inspect phone_number_retail_prices
  console.log('--- 1. PHONE NUMBER RETAIL PRICES (EXPLICIT OVERRIDES) ---');
  const { data: allOverrides, error: overrideErr } = await (supabase as any)
    .from('phone_number_retail_prices')
    .select('*');

  if (overrideErr) {
    console.error('Error fetching retail prices:', overrideErr);
  } else {
    const total = allOverrides.length;
    const active = allOverrides.filter((r: any) => r.is_active === true);
    const inactive = allOverrides.filter((r: any) => r.is_active === false);

    console.log(`Total retail price override rows: ${total}`);
    console.log(`Active override rows: ${active.length}`);
    console.log(`Inactive override rows: ${inactive.length}`);
    if (active.length > 0) {
      console.log('Active override details:', JSON.stringify(active, null, 2));
    } else {
      console.log('  ✓ Verified 0 active explicit retail overrides.');
    }
  }

  // 2. Inspect phone_number_pricing_policies
  console.log('\n--- 2. PHONE NUMBER PRICING POLICIES ---');
  const { data: allPolicies, error: policyErr } = await (supabase as any)
    .from('phone_number_pricing_policies')
    .select('*')
    .eq('is_active', true);

  if (policyErr) {
    console.error('Error fetching pricing policies:', policyErr);
  } else {
    console.log(`Active pricing policy rows found: ${allPolicies.length}`);
    let allTarget30 = true;
    let allMin200 = true;
    let allRoundingNone = true;

    allPolicies.forEach((p: any) => {
      console.log(`- Policy ID: ${p.id} | Country: ${p.country_code} | Type: ${p.number_type} | Currency: ${p.billing_currency} | Margin: ${p.target_margin_pct}% | MinMargin: ${p.minimum_fixed_margin_minor}¢ | Rounding: ${p.rounding_rule} | Active: ${p.is_active}`);

      if (Number(p.target_margin_pct) !== 30) allTarget30 = false;
      if (Number(p.minimum_fixed_margin_minor) !== 200) allMin200 = false;
      if (p.rounding_rule !== 'none') allRoundingNone = false;
    });

    console.log(`Every active policy margin = 30%: ${allTarget30}`);
    console.log(`Every active policy minimum markup = 200 USD minor ($2.00): ${allMin200}`);
    console.log(`Every active policy rounding = none: ${allRoundingNone}`);
  }

  // 3. Live Pricing Resolution Check for US and AU
  console.log('\n--- 3. LIVE MARKETPLACE PRICING RESOLUTION ---');

  // US Local
  const usCost = await ProviderCostService.getProviderCost('US');
  const usMatchingPrice = usCost.prices.find((p) => p.numberType === 'local');
  const usProviderMinor = usMatchingPrice?.currentPriceMinor ?? 0;
  const usExpectedMarkup = Math.max(Math.round(usProviderMinor * 0.30), 200);
  const usExpectedRetailMinor = usProviderMinor + usExpectedMarkup;
  const usExpectedRetailFormatted = `$${(usExpectedRetailMinor / 100).toFixed(2)}`;

  const usRetailRes = await RetailPricingService.resolveRetailPrice('US', 'local', 'USD');
  const usMatch = usRetailRes.hasConfiguredPrice && usRetailRes.monthlyPriceMinor === usExpectedRetailMinor;

  console.log('US Local Pricing:');
  console.log(`  Provider Cost: ${usMatchingPrice?.currentPriceFormatted} (${usProviderMinor}¢)`);
  console.log(`  Expected Markup: $${(usExpectedMarkup / 100).toFixed(2)} (${usExpectedMarkup}¢)`);
  console.log(`  Expected Retail: ${usExpectedRetailFormatted} (${usExpectedRetailMinor}¢)`);
  console.log(`  Actual Marketplace Retail: ${usRetailRes.monthlyPriceFormatted} (${usRetailRes.monthlyPriceMinor}¢)`);
  console.log(`  US Pricing MATCH: ${usMatch ? 'YES' : 'NO'}`);

  // AU Local
  const auCost = await ProviderCostService.getProviderCost('AU');
  const auMatchingPrice = auCost.prices.find((p) => p.numberType === 'local');
  const auProviderMinor = auMatchingPrice?.currentPriceMinor ?? 0;
  const auExpectedMarkup = Math.max(Math.round(auProviderMinor * 0.30), 200);
  const auExpectedRetailMinor = auProviderMinor + auExpectedMarkup;
  const auExpectedRetailFormatted = `$${(auExpectedRetailMinor / 100).toFixed(2)}`;

  const auRetailRes = await RetailPricingService.resolveRetailPrice('AU', 'local', 'USD');
  const auMatch = auRetailRes.hasConfiguredPrice && auRetailRes.monthlyPriceMinor === auExpectedRetailMinor;

  console.log('\nAU Local Pricing:');
  console.log(`  Provider Cost: ${auMatchingPrice?.currentPriceFormatted} (${auProviderMinor}¢)`);
  console.log(`  Expected Markup: $${(auExpectedMarkup / 100).toFixed(2)} (${auExpectedMarkup}¢)`);
  console.log(`  Expected Retail: ${auExpectedRetailFormatted} (${auExpectedRetailMinor}¢)`);
  console.log(`  Actual Marketplace Retail: ${auRetailRes.monthlyPriceFormatted} (${auRetailRes.monthlyPriceMinor}¢)`);
  console.log(`  AU Pricing MATCH: ${auMatch ? 'YES' : 'NO'}`);

  console.log('\n====================================================');
}

verifyRemoteConfig().catch((err) => {
  console.error('Fatal verification error:', err);
  process.exit(1);
});
