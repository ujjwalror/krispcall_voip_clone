import { NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import { RegulatoryPreCheckService, mapDomainToTwilioRegulationNumberType } from '@/lib/telephony/marketplace/regulatoryPreCheckService';

/**
 * GET /api/number-marketplace/regulatory-precheck
 * Evaluates provider regulatory requirements for a country, number type, and end-user type.
 * Server-only execution via Twilio Regulations API.
 */
export async function GET(request: Request) {
  try {
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { searchParams } = new URL(request.url);
    const countryCode = (searchParams.get('countryCode') || searchParams.get('country') || 'US').toUpperCase().trim();
    const numberType = (searchParams.get('numberType') || searchParams.get('type') || 'local').toLowerCase().trim();
    const rawEndUserType = (searchParams.get('endUserType') || 'business').toLowerCase().trim();
    const endUserType = rawEndUserType === 'individual' ? 'individual' : 'business';

    // Fail-closed validation check for supported number types
    const mappedType = mapDomainToTwilioRegulationNumberType(numberType);
    if (!mappedType) {
      return NextResponse.json(
        { error: `Bad Request. Unsupported or invalid number type '${numberType}'. Accepted values: 'local', 'mobile', 'toll_free'.` },
        { status: 400 }
      );
    }

    const result = await RegulatoryPreCheckService.evaluateRequirements(
      countryCode,
      numberType,
      endUserType
    );

    return NextResponse.json({
      success: true,
      preCheck: result,
    });
  } catch (error: any) {
    console.error('[GET /api/number-marketplace/regulatory-precheck] Exception:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error evaluating regulatory requirements.' },
      { status: 500 }
    );
  }
}
