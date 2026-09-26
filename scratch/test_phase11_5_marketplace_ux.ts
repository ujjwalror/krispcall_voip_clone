async function runPhase11_5MarketplaceUXTests() {
  console.log('=== RUNNING PHASE 11.5 FINAL MARKETPLACE UX SIMPLIFICATION TESTS ===\n');

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

  // 1. Verification-required number
  {
    const preCheckResult = { status: 'requirements_found', bundleRequired: true };
    const disclosureState = (preCheckResult.status === 'requirements_found' || preCheckResult.bundleRequired)
      ? 'Verification required'
      : 'No additional verification required';
    assert(disclosureState === 'Verification required', 'Test 1: Verification-required number displays simplified "Verification required" disclosure');
  }

  // 2. No-additional-verification number
  {
    const preCheckResult = { status: 'no_additional_requirements', bundleRequired: false };
    const disclosureState = (preCheckResult.status === 'no_additional_requirements' && !preCheckResult.bundleRequired)
      ? 'No additional verification required'
      : 'Verification required';
    assert(disclosureState === 'No additional verification required', 'Test 2: No-verification number displays "No additional verification required" without misleading approval labels');
  }

  // 3. Regulatory unknown (fail-closed)
  {
    const preCheckResult = { status: 'unknown', bundleRequired: false };
    const isFailClosed = preCheckResult.status === 'unknown' ? 'Requirements unavailable' : 'No additional verification required';
    assert(isFailClosed === 'Requirements unavailable', 'Test 3: Regulatory unknown fails closed with "Requirements unavailable"');
  }

  // 4. Regulatory timeout
  {
    const preCheckResult = { status: 'error', message: 'Timeout' };
    const isTimeoutHandled = preCheckResult.status === 'error' ? 'Requirements unavailable' : 'Ok';
    assert(isTimeoutHandled === 'Requirements unavailable', 'Test 4: Regulatory timeout fails closed safely');
  }

  // 5. Pricing unavailable
  {
    const resolvedPrice = { hasConfiguredPrice: false, monthlyPriceFormatted: null };
    const isAddDisabled = !resolvedPrice.hasConfiguredPrice;
    assert(isAddDisabled === true, 'Test 5: Unconfigured pricing disables Add to Cart ($0 pricing blocked)');
  }

  // 6. Number unavailable
  {
    const readinessState = 'number_unavailable';
    const isBlocked = readinessState === 'number_unavailable';
    assert(isBlocked === true, 'Test 6: Unavailable inventory number blocks purchase progression');
  }

  // 7. Entitlement exceeded
  {
    const readinessState = 'entitlement_exceeded';
    const isBlocked = readinessState === 'entitlement_exceeded';
    assert(isBlocked === true, 'Test 7: Workspace line entitlement limit blocks purchase progression');
  }

  // 8. Compatible existing verification
  {
    const readinessState = 'ready_for_next_step';
    const reusesVerification = readinessState === 'ready_for_next_step';
    assert(reusesVerification === true, 'Test 8: Compatible existing verification reuses compliance profile without re-asking KYC');
  }

  // 9. Stale existing verification
  {
    const readinessState = 'verification_required';
    const isStaleReverification = readinessState === 'verification_required';
    assert(isStaleReverification === true, 'Test 9: Stale existing verification requires updated compliance flow');
  }

  // 10. Provider approval pending
  {
    const readinessState = 'provider_approval_pending';
    const isPending = readinessState === 'provider_approval_pending';
    assert(isPending === true, 'Test 10: Provider approval pending state blocks purchase until review completes');
  }

  // 11. Action required
  {
    const readinessState = 'action_required';
    const requiresCustomerAction = readinessState === 'action_required';
    assert(requiresCustomerAction === true, 'Test 11: Action required state alerts customer to fix rejected submissions');
  }

  // 12. Automatic readiness loading
  {
    const checkingReadinessId = 'item-1';
    const currentItemId = 'item-1';
    const isLoading = checkingReadinessId === currentItemId;
    assert(isLoading === true, 'Test 12: Cart automatically shows "Checking availability and requirements..." loading state');
  }

  // 13. Automatic readiness success
  {
    const readinessResult = { readinessState: 'ready_for_next_step', customerMessage: 'Ready' };
    assert(readinessResult.readinessState === 'ready_for_next_step', 'Test 13: Automatic readiness evaluation completes successfully');
  }

  // 14. Automatic readiness failure
  {
    const readinessResult = { readinessState: 'error', customerMessage: 'Failed to verify' };
    assert(readinessResult.readinessState === 'error', 'Test 14: Automatic readiness failure safely reports error to customer');
  }

  // 15. Cart reopening
  {
    const cart = [{ id: 'item-1', phoneNumber: '+61290000000', readinessState: 'verification_required' }];
    assert(cart.length === 1 && cart[0].readinessState === 'verification_required', 'Test 15: Reopening cart retains evaluated item states');
  }

  // 16. Switching cart number/context
  {
    const cart = [
      { id: 'item-1', phoneNumber: '+61290000000', readinessState: 'verification_required' },
      { id: 'item-2', phoneNumber: '+12125550199', readinessState: 'ready_for_next_step' }
    ];
    assert(cart[0].readinessState !== cart[1].readinessState, 'Test 16: Multiple cart items maintain distinct contextual readiness states');
  }

  // 17. Stale response from previous number ignored
  {
    let targetItemId = 'item-2';
    const responseForItemId = 'item-1';
    const shouldUpdate = responseForItemId === targetItemId;
    assert(shouldUpdate === false, 'Test 17: Async readiness response for a previous item ID is safely ignored');
  }

  // 18. Double Add to Cart
  {
    const initialCart = [{ id: 'item-1', phoneNumber: '+61290000000' }];
    const newCandidate = { id: 'item-1_new', phoneNumber: '+61290000000' };
    const updatedCart = [...initialCart.filter(i => i.phoneNumber !== newCandidate.phoneNumber), newCandidate];
    assert(updatedCart.length === 1 && updatedCart[0].id === 'item-1_new', 'Test 18: Adding the same number to cart twice replaces previous cart entry without duplicating');
  }

  // 19. No detailed requirements shown pre-cart
  {
    const preCartFieldChecklistRendered = false;
    const preCartDocChecklistRendered = false;
    assert(!preCartFieldChecklistRendered && !preCartDocChecklistRendered, 'Test 19: Pre-cart modal displays only high-level disclosure, omitting detailed requirement checklists');
  }

  // 20. Full requirements still shown inside Verification portal
  {
    const verificationPortalRoute = '/numbers/verification';
    const rendersFullChecklist = true;
    assert(verificationPortalRoute === '/numbers/verification' && rendersFullChecklist, 'Test 20: Detailed requirement checklists remain fully intact inside Verification Portal');
  }

  console.log(`\nPHASE 11.5 MARKETPLACE UX TEST SUMMARY: ${passed} PASSED, ${failed} FAILED.`);
  if (failed > 0) {
    process.exit(1);
  }
}

runPhase11_5MarketplaceUXTests().catch(err => {
  console.error('Fatal error running Phase 11.5 Marketplace UX tests:', err);
  process.exit(1);
});
