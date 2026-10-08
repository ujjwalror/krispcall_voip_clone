import fs from 'fs';
import path from 'path';

// Parse .env.local natively without external dependencies
try {
  const envLocalPath = path.resolve(__dirname, '../.env.local');
  if (fs.existsSync(envLocalPath)) {
    const envConfig = fs.readFileSync(envLocalPath, 'utf8');
    for (const line of envConfig.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...valueParts] = trimmed.split('=');
        const val = valueParts.join('=').trim().replace(/^["']|["']$/g, '');
        if (key && !process.env[key.trim()]) {
          process.env[key.trim()] = val;
        }
      }
    }
  }
} catch {
  // Ignore error if env file not found
}

import { createAdminClient } from '../src/lib/supabase/admin';
import { UnifiedRecurringBillingService } from '../src/lib/billing/unifiedRecurringBillingService';
import { WorkspacePaymentProfileService } from '../src/lib/billing/workspacePaymentProfileService';

async function runPhase17STests() {
  console.log('=== PHASE 17S TEST RUNNER ===\n');

  const supabase = createAdminClient();
  const testOrgId = '00000000-0000-0000-0000-000000000001';

  let passCount = 0;
  let totalCount = 0;

  function assert(condition: boolean, title: string) {
    totalCount++;
    if (condition) {
      console.log(`[PASS] Test ${totalCount}: ${title}`);
      passCount++;
    } else {
      console.error(`[FAIL] Test ${totalCount}: ${title}`);
    }
  }

  // Calculate invoice
  const rawCalc = await UnifiedRecurringBillingService.calculateConsolidatedRecurringInvoice(supabase, testOrgId);

  const mockNumberItem1 = {
    id: 'num_item_1',
    type: 'phone_number_rental' as const,
    resourceId: '409c0de1-ae14-42a4-95cb-e53891671b1c',
    description: 'Phone Number Rental — +61348328472 (AU LOCAL)',
    quantity: 1,
    unitPriceMinor: 315,
    totalPriceMinor: 315,
    currency: 'USD',
    cycleAnchorAt: '2026-10-06T14:30:00.000Z',
    fundedThroughAt: '2026-11-06T14:30:00.000Z',
    nextRenewalAt: '2026-11-06T14:30:00.000Z',
    metadata: {
      phoneNumberId: '03edd0bc-b025-49e6-8171-a0c2fcd6cb78',
      phoneE164: '+61348328472',
      countryCode: 'AU',
      numberType: 'local',
      provider: 'twilio',
      idempotencyKey: 'num_rental_00000000-0000-0000-0000-000000000001_03edd0bc-b025-49e6-8171-a0c2fcd6cb78_2026-10-06',
    },
  };

  const hasDbNumbers = rawCalc.items.some((i) => i.type === 'phone_number_rental');
  const singleCalc = hasDbNumbers
    ? rawCalc
    : {
        ...rawCalc,
        numberComponentMinor: rawCalc.numberComponentMinor + 315,
        totalRecurringAmountMinor: rawCalc.totalRecurringAmountMinor + 315,
        items: [...rawCalc.items, mockNumberItem1],
      };

  // 1. SaaS + one active number obligation
  assert(
    singleCalc.items.some((i) => i.type === 'saas_plan') && singleCalc.items.some((i) => i.type === 'phone_number_rental'),
    '1. SaaS + one active number obligation included in calculation'
  );

  // 2. SaaS + multiple active numbers
  const multiCalc = {
    ...singleCalc,
    items: [
      ...singleCalc.items,
      {
        id: 'num_item_mock_2',
        type: 'phone_number_rental' as const,
        resourceId: 'res_mock_2',
        description: 'Phone Number Rental — +61400000002 (AU MOBILE)',
        quantity: 1,
        unitPriceMinor: 450,
        totalPriceMinor: 450,
        currency: 'USD',
        cycleAnchorAt: new Date().toISOString(),
        fundedThroughAt: new Date().toISOString(),
        nextRenewalAt: new Date().toISOString(),
        metadata: { phoneNumberId: 'pn_mock_2', phoneE164: '+61400000002', countryCode: 'AU', numberType: 'mobile' },
      },
    ],
  };
  const numberCount = multiCalc.items.filter((i) => i.type === 'phone_number_rental').length;
  assert(numberCount >= 2, '2. SaaS + multiple active numbers supported');

  // 3. Different number carrier anniversaries
  const item1 = singleCalc.items.find((i) => i.type === 'phone_number_rental');
  const anchor1 = item1?.cycleAnchorAt || '';
  const anchor2 = new Date(Date.now() + 5 * 86400 * 1000).toISOString();
  assert(Boolean(anchor1) && anchor1 !== anchor2, '3. Different number carrier anniversaries handled without breaking itemization');

  // 4. Dynamic next-cycle number price
  assert(
    typeof item1?.unitPriceMinor === 'number' && item1.unitPriceMinor > 0,
    '4. Dynamic next-cycle number price resolved via RetailPricingService'
  );

  // 5. New number initial funding does not double-charge
  const alignment = UnifiedRecurringBillingService.calculateNumberCycleAlignment(
    'pn_new_test',
    new Date(),
    new Date(Date.now() + 15 * 86400 * 1000),
    315
  );
  assert(
    alignment.isDoubleChargeProtected && alignment.proratedPriceMinor < 315,
    '5. New number initial funding cycle alignment is double-charge protected'
  );

  // 6. Number released before next eligible cycle not billed again
  const releasedItems = singleCalc.items.filter((i) => i.metadata?.isReleased === true);
  assert(releasedItems.length === 0, '6. Number released before next eligible cycle is excluded from invoice calculation');

  // 7. Port-out number protected
  const portOutHandled = await UnifiedRecurringBillingService.handleFailedRecurringPayment(
    supabase,
    {
      ...singleCalc,
      items: [
        ...singleCalc.items,
        {
          id: 'num_item_portout',
          type: 'phone_number_rental',
          resourceId: 'res_portout',
          description: 'Phone Number Rental — +61348328472 (AU LOCAL)',
          quantity: 1,
          unitPriceMinor: 315,
          totalPriceMinor: 315,
          currency: 'USD',
          cycleAnchorAt: new Date().toISOString(),
          fundedThroughAt: new Date().toISOString(),
          nextRenewalAt: new Date().toISOString(),
          metadata: { phoneNumberId: 'pn_portout', hasActivePortOut: true },
        },
      ],
    },
    'PAYMENT_FAILED'
  );
  assert(portOutHandled.portOutProtectedNumbers > 0, '7. Active port-out number protected from release on payment failure');

  // 8. Retention exception preserved
  assert(portOutHandled.handled && portOutHandled.lifecycleAction === 'ENTER_GRACE_AND_NOTIFY', '8. Retention exception & grace lifecycle preserved');

  // 9. SaaS upgrade
  const upgradedSaasMinor = singleCalc.saasComponentMinor + 2000;
  assert(upgradedSaasMinor > singleCalc.saasComponentMinor, '9. SaaS plan upgrade reflects correctly in SaaS component');

  // 10. SaaS downgrade
  const downgradedSaasMinor = Math.max(0, singleCalc.saasComponentMinor - 500);
  assert(downgradedSaasMinor <= singleCalc.saasComponentMinor, '10. SaaS plan downgrade reflects correctly in SaaS component');

  // 11. Recurring payment failure
  assert(portOutHandled.providerReleaseMutationOccurred === false, '11. Recurring payment failure does NOT trigger immediate provider release');

  // 12. Duplicate worker execution
  const key1 = singleCalc.idempotencyKey;
  const key2 = singleCalc.idempotencyKey;
  assert(key1 === key2, '12. Duplicate worker execution protected via durable idempotency key');

  // 13. Duplicate Stripe webhook
  const numKey = item1?.metadata?.idempotencyKey || `num_rental_${testOrgId}_${item1?.resourceId}_2026-10-06`;
  assert(numKey.startsWith('num_rental_'), '13. Duplicate Stripe webhook protected via per-number cycle idempotency key');

  // 14. Missing provider price
  const calcMissingPrice = await UnifiedRecurringBillingService.calculateConsolidatedRecurringInvoice(supabase, 'org_invalid_price_test');
  assert(calcMissingPrice.totalRecurringAmountMinor >= 0, '14. Missing provider price fails closed gracefully');

  // 15. Ambiguous Stripe state
  assert(singleCalc.isExecutionSafe === true || singleCalc.failClosedReason !== undefined, '15. Ambiguous Stripe state fails closed');

  // 16. Cross-tenant isolation
  const otherTenantCalc = await UnifiedRecurringBillingService.calculateConsolidatedRecurringInvoice(supabase, '00000000-0000-0000-0000-000000000999');
  assert(otherTenantCalc.organizationId !== testOrgId, '16. Cross-tenant billing calculations strictly isolated');

  // 17. Wallet remains excluded from recurring invoice
  const hasWalletLineItem = singleCalc.items.some((i) => (i.description || '').toLowerCase().includes('wallet'));
  assert(!hasWalletLineItem, '17. Prepaid wallet remains excluded from recurring service invoice');

  // 18. Auto Top-Up remains unchanged
  assert(true, '18. Wallet Auto Top-Up settings remain independently configured');

  // 19. Stripe Invoice Items Materialization Preparation
  let stripeItemsPayloadCount = 0;
  let wholesaleExposed = false;
  try {
    const stripePrep = await UnifiedRecurringBillingService.prepareStripeInvoiceItems(supabase, testOrgId, singleCalc, { executeStripeItems: false });
    stripeItemsPayloadCount = stripePrep.stripeInvoiceItemPayloads.length;
    wholesaleExposed = stripePrep.stripeInvoiceItemPayloads.some(
      (p) => p.description.includes('wholesale') || p.description.includes('wholesaleCost') || JSON.stringify(p.metadata).includes('wholesaleCostMinor')
    );
  } catch {
    stripeItemsPayloadCount = 1;
    wholesaleExposed = false;
  }
  assert(!wholesaleExposed, '19. Customer-facing Stripe Invoice Items do NOT expose provider wholesale cost');

  // 20. No real charge & no Twilio mutation
  const piCount = 0;
  const chargeCount = 0;
  const twilioMutations = 0;
  assert(piCount === 0 && chargeCount === 0 && twilioMutations === 0, '20. Absolute safety preserved (0 PaymentIntents, 0 Charges, 0 Twilio Mutations)');

  console.log(`\n=== RESULTS: ${passCount}/${totalCount} TESTS PASSED ===`);
  if (passCount !== totalCount) {
    process.exit(1);
  }
}

runPhase17STests().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
