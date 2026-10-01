import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import { createAdminClient } from '@/lib/supabase/admin';
import { formatMinorUnitsToCurrency } from '@/lib/billing/currencyFormatter';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export interface MapCategoryResult {
  category: string;
  defaultDescription: string;
}

/**
 * Hardened ISO-Aware Customer Transaction Category Classifier (C.3A).
 * Enforces strict semantic classification based on authoritative entry_type.
 * Free-text description parsing (e.g. description.includes("SMS")) is strictly prohibited.
 */
export function mapCustomerTransactionCategory(entryType: string): MapCategoryResult {
  switch (entryType) {
    case 'grant':
      return { category: 'Credits Added', defaultDescription: 'Credits added to wallet' };
    case 'auto_recharge':
      return { category: 'Auto Top-Up', defaultDescription: 'Auto Top-Up credits added' };
    case 'usage_reversal':
      return { category: 'Usage Reversal', defaultDescription: 'Telecom usage charge reversed' };
    case 'telecom_usage':
      return { category: 'Telecom Usage', defaultDescription: 'Telecom usage charge' };
    case 'consumption':
      return { category: 'Credits Used', defaultDescription: 'Credits consumed' };
    case 'adjustment':
      return { category: 'Credits Adjustment', defaultDescription: 'Account credits adjustment' };
    case 'expiration':
      return { category: 'Credits Expired', defaultDescription: 'Unused credits expired' };
    default:
      return { category: 'Credits Transaction', defaultDescription: 'Account transaction' };
  }
}

/**
 * Sanitizes description strings to ensure raw provider SIDs or internal operation details are not exposed.
 */
function sanitizeCustomerDescription(rawDescription: string, defaultDescription: string): string {
  if (!rawDescription || rawDescription.trim().length === 0) {
    return defaultDescription;
  }

  const trimmed = rawDescription.trim();
  // Filter out raw Twilio CallSids (CA...), MessageSids (SM.../MM...), or uuid strings if present in description
  if (/^(CA|SM|MM)[a-f0-9]{32}$/i.test(trimmed) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return defaultDescription;
  }

  return trimmed;
}

export async function GET(req: NextRequest) {
  try {
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { user, supabase } = sessionResult;

    // Server-authoritative organization & role resolution
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('organization_id, role, active')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'FORBIDDEN: Active organization profile required.', code: 'forbidden' },
        { status: 403 }
      );
    }

    // SERVER-AUTHORITATIVE TENANT ISOLATION:
    // Ignore any browser-supplied organization_id parameter! Use profile.organization_id exclusively.
    const organizationId = profile.organization_id;

    const { searchParams } = new URL(req.url);
    let limit = parseInt(searchParams.get('limit') || '10', 10);
    let offset = parseInt(searchParams.get('offset') || '0', 10);

    if (isNaN(limit) || limit < 1) limit = 10;
    if (limit > 50) limit = 50; // Cap max limit at 50 per page
    if (isNaN(offset) || offset < 0) offset = 0;

    const adminSupabase = createAdminClient();

    const { data: rows, count, error: dbError } = await adminSupabase
      .from('billing_credit_ledger')
      .select('id, entry_type, amount_minor, balance_after_minor, currency, description, created_at', { count: 'exact' })
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);

    if (dbError) {
      console.error('[GET /api/billing/credit/history] DB Error:', dbError.message);
      return NextResponse.json(
        { error: 'TRANSACTION_HISTORY_UNAVAILABLE', message: 'Transaction history is temporarily unavailable.' },
        { status: 500 }
      );
    }

    const total = count || 0;
    const transactions = (rows || []).map((row: any) => {
      const amount = Number(row.amount_minor);
      const balanceAfter = Number(row.balance_after_minor);
      const currency = row.currency || 'USD';
      
      const { category, defaultDescription } = mapCustomerTransactionCategory(row.entry_type);
      const safeDescription = sanitizeCustomerDescription(row.description, defaultDescription);

      const formattedAbs = formatMinorUnitsToCurrency(Math.abs(amount), currency);
      const formattedAmount = amount > 0 ? `+${formattedAbs}` : `-${formattedAbs}`;
      const formattedBalanceAfter = formatMinorUnitsToCurrency(balanceAfter, currency);

      // CUSTOMER-SAFE RESPONSE CONTRACT:
      // Exclude provider SIDs, wholesale costs, rate card IDs, idempotency keys, and internal metadata.
      return {
        id: row.id,
        occurredAt: row.created_at,
        category,
        description: safeDescription,
        amountMinor: amount,
        formattedAmount,
        balanceAfterMinor: balanceAfter,
        formattedBalanceAfter,
        currency,
      };
    });

    return NextResponse.json(
      {
        success: true,
        transactions,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + transactions.length < total,
        },
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        },
      }
    );
  } catch (error: any) {
    console.error('[GET /api/billing/credit/history] Unexpected error:', error.message || error);
    return NextResponse.json(
      { error: 'TRANSACTION_HISTORY_UNAVAILABLE', message: 'Transaction history is temporarily unavailable.' },
      { status: 500 }
    );
  }
}
