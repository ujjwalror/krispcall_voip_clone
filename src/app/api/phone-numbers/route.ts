import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { EntitlementAuthorizationService } from '@/lib/telecom/billing/entitlementAuthorizationService';
import { canonicalErrorResponse } from '@/lib/telecom/errors/canonicalErrorContract';

/**
 * Sanitizes internal database phone number row to customer-safe canonical representation.
 * STRICT REDACTION:
 * - Omits raw carrier secrets, auth tokens, provider payload blobs, and raw PII.
 * - Exposes 5 orthogonal canonical dimensions: ownership, service, billing, porting, compliance.
 * - Preserves display-only compatibility projections.
 */
function sanitizePhoneNumberRow(row: any): Record<string, any> {
  const ownershipState = row.ownership_state || (row.status === 'active' ? 'OWNED' : 'ACQUISITION_PENDING');
  const serviceState = row.service_state || (row.status === 'active' && row.active ? 'ACTIVE' : 'SUSPENDED');
  const assignmentTargetType = row.assignment_target_type || 'UNASSIGNED_POOL';

  return {
    id: row.id,
    phone_number: row.phone_number,
    phone_number_e164: row.phone_number_e164 || row.phone_number,
    friendly_name: row.friendly_name || null,
    country_code: row.country_code || 'US',
    is_primary: Boolean(row.is_primary),
    // Canonical Dimensions (Phase 23D.1 / 23D.10B)
    ownership_state: ownershipState,
    service_state: serviceState,
    porting_state: row.porting_state || 'NONE',
    compliance_state: row.compliance_state || 'NOT_REQUIRED',
    capabilities_state: row.capabilities_state || {
      VOICE_INBOUND: { stage: 'USABLE' },
      VOICE_OUTBOUND: { stage: 'USABLE' },
      SMS_INBOUND: { stage: 'USABLE' },
      SMS_OUTBOUND: { stage: 'USABLE' },
    },
    // Canonical Assignment (Phase 23D.5)
    assignment_target_type: assignmentTargetType,
    assignment_target_id: row.assignment_target_id || null,
    assigned_at: row.assigned_at || null,
    provider_account_id: row.provider_account_id || null,
    // Display-only Compatibility Projections (Phase 23D.10B)
    active: row.active ?? true,
    status: row.status || 'active',
    capabilities: row.capabilities || { voice: true, sms: true, mms: false },
    inbound_routing_type: row.inbound_routing_type || 'user',
    inbound_routing_destination_id: row.inbound_routing_destination_id || null,
    unanswered_call_strategy: row.unanswered_call_strategy || 'voicemail',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * GET /api/phone-numbers
 * Fetches provider-neutral business numbers for the authenticated user's organization.
 * Strictly derives organization identity server-side from session auth.uid().
 */
export async function GET() {
  try {
    const supabase = await createServerSupabaseClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return canonicalErrorResponse(new Error('Unauthorized. Authenticated session required.'), {
        customCode: 'ROLE_NOT_AUTHORIZED',
        httpStatus: 401,
      });
    }

    const { data: profile, error: profileError } = await (supabase as any)
      .from('profiles')
      .select('organization_id, role, active')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile || !profile.organization_id || profile.active === false) {
      return canonicalErrorResponse(new Error('TENANT_MISMATCH: User organization unconfigured or account inactive.'), {
        httpStatus: 403,
      });
    }

    const isOwnerOrAdmin = ['owner', 'admin'].includes(profile.role || '');
    const adminSupabase = createAdminClient();

    let slotSummary = null;
    try {
      slotSummary = await EntitlementAuthorizationService.getSlotCapacityDetails(
        profile.organization_id,
        adminSupabase
      );
    } catch (slotErr) {
      console.warn('[GET /api/phone-numbers] Slot capacity lookup warning:', slotErr);
    }

    if (isOwnerOrAdmin) {
      // Fetch active lifecycle business numbers for the authenticated organization (excluding terminal released/ported_out rows)
      const { data: phoneNumbers, error: fetchError } = await (adminSupabase as any)
        .from('phone_numbers')
        .select('*')
        .eq('organization_id', profile.organization_id)
        .not('ownership_state', 'in', '("RELEASED","PORTED_OUT")')
        .order('is_primary', { ascending: false })
        .order('created_at', { ascending: true });

      if (fetchError) {
        return canonicalErrorResponse(fetchError, {
          customMessage: 'Failed to retrieve business numbers.',
          httpStatus: 500,
        });
      }

      const sanitized = (phoneNumbers || []).map(sanitizePhoneNumberRow);

      return NextResponse.json({
        success: true,
        phoneNumbers: sanitized,
        slotSummary,
      });
    } else {
      // Manager/Agent: Query numbers where user is canonical target or assigned via compatibility mapping
      const { data: canonicalAssigned, error: canonErr } = await (adminSupabase as any)
        .from('phone_numbers')
        .select('*')
        .eq('organization_id', profile.organization_id)
        .eq('assignment_target_type', 'USER')
        .eq('assignment_target_id', user.id)
        .not('ownership_state', 'in', '("RELEASED","PORTED_OUT")');

      // Also check legacy user_phone_assignments for backward compatibility
      const { data: userAssignments } = await (adminSupabase as any)
        .from('user_phone_assignments')
        .select('phone_number_id, phone_numbers:phone_number_id (*)')
        .eq('user_id', user.id)
        .eq('organization_id', profile.organization_id);

      const legacyAssigned = (userAssignments || [])
        .map((a: any) => a.phone_numbers)
        .filter(Boolean);

      const combinedMap = new Map<string, any>();
      for (const row of canonicalAssigned || []) {
        combinedMap.set(row.id, row);
      }
      for (const row of legacyAssigned) {
        if (!combinedMap.has(row.id)) {
          combinedMap.set(row.id, row);
        }
      }

      const sanitized = Array.from(combinedMap.values()).map(sanitizePhoneNumberRow);

      return NextResponse.json({
        success: true,
        phoneNumbers: sanitized,
        slotSummary,
      });
    }
  } catch (error: any) {
    return canonicalErrorResponse(error);
  }
}
