import { NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import { createAdminClient } from '@/lib/supabase/admin';
import { NumberPurchaseSagaCoordinator } from '@/lib/telecom/saga/numberPurchaseSagaCoordinator';
import { EntitlementAuthorizationService } from '@/lib/telecom/billing/entitlementAuthorizationService';
import { PriceQuoteValidator } from '@/lib/telecom/saga/priceQuoteValidator';
import { canonicalErrorResponse } from '@/lib/telecom/errors/canonicalErrorContract';
import { NumberPurchaseVelocityLimiter } from '@/lib/telephony/marketplace/numberPurchaseVelocityLimiter';

/**
 * POST /api/number-marketplace/purchase
 * Authoritative Canonical Purchase Route (Phase 23D.3 + 23D.9 + 23D.10B + 24D.SEC-7F).
 * Strictly delegates customer number acquisition to NumberPurchaseSagaCoordinator.
 * Zero uncoordinated carrier purchases.
 */
export async function POST(request: Request) {
  try {
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { user, supabase } = sessionResult;

    // 1. Fetch user profile and verify active organization membership & role
    const { data: profile } = await supabase
      .from('profiles')
      .select('organization_id, role, active')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || !profile.organization_id || profile.active === false) {
      return canonicalErrorResponse(new Error('TENANT_MISMATCH: Active organization profile required.'), {
        httpStatus: 403,
      });
    }

    // Role gate: Only Owner or Admin can execute number purchases
    const userRole = (profile.role || '').toLowerCase();
    if (userRole !== 'owner' && userRole !== 'admin') {
      return canonicalErrorResponse(
        new Error('ROLE_NOT_AUTHORIZED: Phone number purchasing requires Owner or Admin role privileges.'),
        { httpStatus: 403 }
      );
    }

    const adminDb = createAdminClient();
    const body = await request.json().catch(() => ({}));

    // 2. Input Validation
    const phoneNumberE164 = (body.phoneNumberE164 || body.phoneNumber || '').trim();
    const countryCode = (body.countryCode || 'US').trim().toUpperCase();
    const numberType = (body.numberType || 'local').trim().toLowerCase();
    const idempotencyKey = (body.idempotencyKey || '').trim();

    if (!phoneNumberE164 || !/^\+[1-9]\d{1,14}$/.test(phoneNumberE164)) {
      return canonicalErrorResponse(new Error('Valid E.164 phone number is required.'), {
        httpStatus: 400,
      });
    }

    if (!idempotencyKey || idempotencyKey.length < 8) {
      return canonicalErrorResponse(new Error('Valid idempotencyKey (min 8 characters) is required.'), {
        httpStatus: 400,
      });
    }

    // 3. Protected Australian Pilot Quarantine Check
    if (phoneNumberE164 === '+61348328472') {
      return canonicalErrorResponse(new Error('PROTECTED_PILOT_QUARANTINE: Protected Australian pilot number cannot be purchased.'));
    }

    // 4. Phase 24D.SEC-7F: Distributed Purchase Velocity & In-Flight Concurrency Defense
    const velocityCheck = await NumberPurchaseVelocityLimiter.checkAndConsumeRateLimit(
      {
        organizationId: profile.organization_id,
        userId: user.id,
        phoneNumberE164,
        idempotencyKey,
      },
      adminDb
    );

    if (!velocityCheck.allowed) {
      const isStorageError = velocityCheck.limitType === 'limiter_storage_error';
      const httpStatus = isStorageError ? 503 : 429;
      const headers: Record<string, string> = {};
      if (velocityCheck.retryAfterSeconds > 0) {
        headers['Retry-After'] = String(velocityCheck.retryAfterSeconds);
      }

      return NextResponse.json(
        {
          success: false,
          error: velocityCheck.reason,
          errorCode: isStorageError
            ? 'PURCHASE_VELOCITY_LIMITER_UNAVAILABLE'
            : 'PURCHASE_VELOCITY_LIMIT_EXCEEDED',
          limitType: velocityCheck.limitType,
          retryAfterSeconds: velocityCheck.retryAfterSeconds,
        },
        {
          status: httpStatus,
          headers,
        }
      );
    }

    // 5. Pre-check Organization Slot Entitlement & Over-Entitlement Status (Phase 23D.9)
    const slotCapacity = await EntitlementAuthorizationService.getSlotCapacityDetails(
      profile.organization_id,
      adminDb
    );

    if (slotCapacity.isOverEntitled) {
      return canonicalErrorResponse(new Error('OVER_ENTITLED: Workspace is currently over-entitled and cannot acquire numbers.'));
    }

    if (slotCapacity.remainingSlots !== null && slotCapacity.remainingSlots <= 0) {
      return canonicalErrorResponse(new Error('NO_NUMBER_SLOT_AVAILABLE: Workspace has exhausted all available number slots.'));
    }

    // 6. Canonical Signed Quote Validation (Phase 23D.3 / Task 5)
    let validatedQuote = body.quote || null;
    if (validatedQuote) {
      const quoteCheck = await PriceQuoteValidator.validateQuote(
        {
          quote: validatedQuote,
          organizationId: profile.organization_id,
          phoneNumberE164,
          expectedCountryCode: countryCode,
          expectedNumberType: numberType,
        },
        adminDb
      );

      if (!quoteCheck.valid) {
        return canonicalErrorResponse(
          new Error(quoteCheck.errorMessage || quoteCheck.errorCode || 'INVALID_QUOTE'),
          {
            customCode: quoteCheck.errorCode,
          }
        );
      }
    }

    // 6. Delegate strictly to Canonical NumberPurchaseSagaCoordinator
    const sagaResult = await NumberPurchaseSagaCoordinator.executePurchase(
      {
        organizationId: profile.organization_id,
        phoneNumberE164,
        countryCode,
        numberType: numberType as any,
        idempotencyKey,
        quote: validatedQuote,
        financialAuth: body.financialAuth || null,
        complianceProfileId: body.complianceProfileId || null,
        complianceCaseId: body.complianceCaseId || null,
        regulatoryBundleSid: body.regulatoryBundleSid || null,
        authoritativeComplianceNotRequired: body.authoritativeComplianceNotRequired || false,
        endUserType: body.endUserType || null,
        friendlyName: body.friendlyName || null,
        providerContext: body.providerContext || null,
      },
      adminDb
    );

    if (!sagaResult.success) {
      // Map saga error safely through Canonical Error Contract
      return canonicalErrorResponse(
        new Error(sagaResult.errorMessage || sagaResult.errorCode || 'PURCHASE_FAILED'),
        {
          customCode: sagaResult.errorCode || 'PURCHASE_FAILED',
          operationId: sagaResult.operationId,
        }
      );
    }

    return NextResponse.json({
      success: true,
      operation: sagaResult,
    });
  } catch (error: any) {
    return canonicalErrorResponse(error);
  }
}
