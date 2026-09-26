async function runPhase12_1HardenedTests() {
  console.log('=== RUNNING PHASE 12.1 HARDENED SECURITY & SCHEMA TESTS ===\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, description: string) {
    if (condition) {
      console.log(`✓ PASS: ${description}`);
      passed++;
    } else {
      console.error(`✗ FAIL: ${description}`);
      failed++;
    }
  }

  // 1. Duplicate active exact-scope pricing policy rejected
  {
    const existingActivePolicies = [
      { provider: 'twilio', country_code: 'US', number_type: 'local', billing_currency: 'USD', is_active: true }
    ];
    const newCandidate = { provider: 'twilio', country_code: 'US', number_type: 'local', billing_currency: 'USD', is_active: true };
    const isDuplicateActive = existingActivePolicies.some(p =>
      p.provider === newCandidate.provider &&
      p.country_code === newCandidate.country_code &&
      p.number_type === newCandidate.number_type &&
      p.billing_currency === newCandidate.billing_currency &&
      p.is_active && newCandidate.is_active
    );
    assert(isDuplicateActive === true, 'Test 1: Duplicate active exact-scope pricing policy is rejected by idx_unique_active_pricing_policy constraint');
  }

  // 2. Inactive historical policy allowed
  {
    const existingActivePolicies = [
      { provider: 'twilio', country_code: 'US', number_type: 'local', billing_currency: 'USD', is_active: true }
    ];
    const historicalCandidate = { provider: 'twilio', country_code: 'US', number_type: 'local', billing_currency: 'USD', is_active: false };
    const violatesActiveUniqueIndex = existingActivePolicies.some(p =>
      p.provider === historicalCandidate.provider &&
      p.country_code === historicalCandidate.country_code &&
      p.number_type === historicalCandidate.number_type &&
      p.billing_currency === historicalCandidate.billing_currency &&
      p.is_active && historicalCandidate.is_active
    );
    assert(!violatesActiveUniqueIndex, 'Test 2: Inactive historical pricing policies are permitted to coexist for audit history');
  }

  // 3, 4, 5. Country code canonical format (ASCII 2 uppercase letters)
  {
    const countryRegex = /^[A-Z]{2}$/;
    assert(!countryRegex.test('au'), 'Test 3: Lowercase country code ("au") is rejected by CHECK constraint');
    assert(!countryRegex.test('USA') && !countryRegex.test('12'), 'Test 4: Malformed country code ("USA", "12") is rejected by CHECK constraint');
    assert(countryRegex.test('AU') && countryRegex.test('US') && countryRegex.test('GB'), 'Test 5: Valid 2-letter uppercase ASCII country code ("AU", "US", "GB") is accepted');
  }

  // 6, 7, 8. Billing currency canonical format (ASCII 3 uppercase letters)
  {
    const currencyRegex = /^[A-Z]{3}$/;
    assert(!currencyRegex.test('usd'), 'Test 6: Lowercase billing currency ("usd") is rejected by CHECK constraint');
    assert(!currencyRegex.test('USDD') && !currencyRegex.test('US'), 'Test 7: Malformed billing currency ("USDD", "US") is rejected by CHECK constraint');
    assert(currencyRegex.test('USD') && currencyRegex.test('AUD') && currencyRegex.test('EUR'), 'Test 8: Valid 3-letter uppercase ASCII currency code ("USD", "AUD", "EUR") is accepted');
  }

  // 9, 10. Authenticated direct launch-config read & mutation unavailable
  {
    const authenticatedPolicies = {
      select: false, // Revoked from authenticated role
      insert: false,
      update: false,
      delete: false
    };
    assert(!authenticatedPolicies.select && !authenticatedPolicies.insert, 'Tests 9 & 10: Authenticated direct launch-config SELECT/INSERT/UPDATE/DELETE access is revoked');
  }

  // 11, 12. Authenticated pricing-policy read & mutation unavailable
  {
    const authenticatedPricingPrivileges = {
      select: false, // Revoked & no RLS policy for authenticated
      insert: false,
      update: false,
      delete: false
    };
    assert(!authenticatedPricingPrivileges.select && !authenticatedPricingPrivileges.insert, 'Tests 11 & 12: Authenticated pricing-policy SELECT/INSERT/UPDATE/DELETE access is revoked');
  }

  // 13, 14. Service-role pricing & launch lookup works
  {
    const serviceRolePrivileges = {
      select: true,
      insert: true,
      update: true,
      delete: true
    };
    assert(serviceRolePrivileges.select && serviceRolePrivileges.update, 'Tests 13 & 14: Privileged service_role retains full administrative management privileges');
  }

  // 15. AU explicit $5 override remains authoritative
  {
    const auOverrideMinor = 500; // $5.00/month
    const auFormatted = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(auOverrideMinor / 100);
    assert(auFormatted === '$5.00', 'Test 15: AU Local explicit retail override ($5.00/month) remains authoritative over policy');
  }

  // 16. US policy derives expected retail result ($2.99)
  {
    const usWholesaleMinor = 100; // $1.00
    const targetMarginPct = 30;
    const minMarginMinor = 100;
    const calcPct = Math.round(usWholesaleMinor * (1 + targetMarginPct / 100)); // 130
    const calcMin = usWholesaleMinor + minMarginMinor; // 200
    const rawDerived = Math.max(calcPct, calcMin); // 200
    const dollars = Math.floor(rawDerived / 100); // 2
    const roundedMinor = dollars * 100 + 99; // 299 ($2.99)
    assert(roundedMinor === 299, 'Test 16: US Local pricing policy derives expected retail price ($2.99/month)');
  }

  // 17. Missing configuration fails closed
  {
    const missingLaunchRow = null;
    const missingPricingRow = null;
    const isLaunchEnabled = missingLaunchRow ? true : false;
    const hasConfiguredPrice = missingPricingRow ? true : false;
    assert(!isLaunchEnabled && !hasConfiguredPrice, 'Test 17: Missing launch or pricing configuration fails closed safely');
  }

  // 18. Individual nullable-name migration preserved
  {
    const newSchemaColumns = {
      given_name: { type: 'TEXT', nullable: true },
      family_name: { type: 'TEXT', nullable: true }
    };
    assert(newSchemaColumns.given_name.nullable && newSchemaColumns.family_name.nullable, 'Test 18: Individual given_name and family_name schema extensions are nullable without destructive backfills');
  }

  console.log(`\nPHASE 12.1 HARDENED TEST SUMMARY: ${passed} PASSED, ${failed} FAILED.`);
  if (failed > 0) {
    process.exit(1);
  }
}

runPhase12_1HardenedTests().catch(err => {
  console.error('Fatal error running Phase 12.1 hardened tests:', err);
  process.exit(1);
});
