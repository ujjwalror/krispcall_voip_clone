import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { TelecomProviderPricingSyncService, DEFAULT_APPROVED_COUNTRY_SCOPE } from '../lib/billing/telecom/telecomPricingSyncService';

/**
 * Portable Node worker process for telecom wholesale pricing synchronization.
 * Entrypoint: npm run worker:telecom-pricing-sync
 */
export async function runTelecomPricingSyncWorker() {
  console.log('================================================================');
  console.log('[Worker:TelecomPricingSync] Starting Wholesale Pricing Ingestion');
  console.log('================================================================');

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseSecretKey) {
    console.error('[Worker:TelecomPricingSync] Error: Missing Supabase environment configuration.');
    process.exit(1);
  }

  const gateEnabled = TelecomProviderPricingSyncService.isMutationGateEnabled();
  if (!gateEnabled) {
    console.warn('[Worker:TelecomPricingSync] TELECOM_PRICING_SYNC_ENABLED is false/off.');
    console.warn('[Worker:TelecomPricingSync] Worker mutation gate is CLOSED. No pricing cache or sync runs will be modified.');
    console.log('[Worker:TelecomPricingSync] Exiting cleanly without mutation.');
    return;
  }

  const client = createClient(supabaseUrl, supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const syncService = new TelecomProviderPricingSyncService();
  console.log(`[Worker:TelecomPricingSync] Initiating sync for approved countries: ${DEFAULT_APPROVED_COUNTRY_SCOPE.join(', ')}`);

  const result = await syncService.syncApprovedCountries(client, {
    countries: DEFAULT_APPROVED_COUNTRY_SCOPE,
  });

  console.log('\n----------------------------------------------------------------');
  console.log('[Worker:TelecomPricingSync] Sync Run Summary:');
  console.log(`Provider Key: ${result.providerKey}`);
  console.log(`Provider Account: ${result.providerAccountId}`);
  console.log(`Total Countries Attempted: ${result.totalCountriesAttempted}`);
  console.log(`Total Countries Succeeded: ${result.totalCountriesSucceeded}`);
  console.log(`Total Countries Failed: ${result.totalCountriesFailed}`);
  console.log(`Total Records Observed: ${result.totalRecordsObserved}`);
  console.log(`Total Records Inserted: ${result.totalRecordsInserted}`);
  console.log(`Total Records Refreshed: ${result.totalRecordsRefreshed}`);
  console.log(`Total Records Versioned: ${result.totalRecordsVersioned}`);
  console.log(`Total Records Rejected: ${result.totalRecordsRejected}`);
  console.log('----------------------------------------------------------------\n');

  if (!result.success) {
    console.error('[Worker:TelecomPricingSync] One or more countries failed during synchronization.');
    process.exit(1);
  }

  console.log('[Worker:TelecomPricingSync] Pricing synchronization completed successfully.');
}

if (require.main === module) {
  runTelecomPricingSyncWorker().catch((err) => {
    console.error('[Worker:TelecomPricingSync] Fatal uncaught exception:', err);
    process.exit(1);
  });
}
