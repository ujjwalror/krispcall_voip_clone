import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  ProviderContext,
  ProviderResolutionIntent,
  ProviderResolutionResult,
  ResolvePlatformAdminAccountParams,
  ResolveProviderAccountParams,
  TelecomServiceScope,
} from './types';

export const SHARED_PARENT_TWILIO_ID = '00000000-0000-0000-0000-000000000001';
export const SHARED_PARENT_ACCOUNT_REFERENCE = 'shared_parent_twilio';
export const PLATFORM_ADMIN_ORGANIZATION_ID = '00000000-0000-0000-0000-000000000000';

export interface ProviderSecurityEvent {
  ruleId:
    | 'PROVIDER_ASSIGNMENT_MISSING'
    | 'PROVIDER_ACCOUNT_INACTIVE'
    | 'PARENT_ACCOUNT_CUSTOMER_ACCESS_BLOCKED'
    | 'PROVIDER_ACCOUNT_ENVIRONMENT_MISMATCH'
    | 'CLIENT_OVERRIDE_ATTEMPT'
    | 'MALFORMED_PROVIDER_RECORD'
    | 'CUSTOMER_STRICT_RESOLUTION_VIOLATION'
    | 'BILLING_RESOURCE_PERSISTENCE_FAILED';
  organizationId?: string;
  providerAccountId?: string;
  service?: TelecomServiceScope;
  intent?: ProviderResolutionIntent;
  details?: Record<string, any>;
  timestamp: string;
}

function sanitizeSecurityEventDetails(details?: Record<string, any>): Record<string, any> {
  if (!details || typeof details !== 'object') return {};
  const sanitized: Record<string, any> = {};
  const forbiddenPatterns = [/token/i, /secret/i, /key/i, /password/i, /auth/i, /credential/i, /authorization/i, /bearer/i];

  for (const [key, value] of Object.entries(details)) {
    if (forbiddenPatterns.some((pattern) => pattern.test(key))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'string' && value.length > 256) {
      sanitized[key] = value.substring(0, 256) + '...[TRUNCATED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      sanitized[key] = sanitizeSecurityEventDetails(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export class ProviderAccountResolver {
  private static securityEvents: ProviderSecurityEvent[] = [];

  static emitSecurityEvent(
    event: Omit<ProviderSecurityEvent, 'timestamp'>,
    clientOverride?: SupabaseClient
  ): void {
    const sanitizedDetails = sanitizeSecurityEventDetails(event.details);
    const fullEvent: ProviderSecurityEvent = {
      ...event,
      details: sanitizedDetails,
      timestamp: new Date().toISOString(),
    };
    this.securityEvents.push(fullEvent);
    console.warn(`[SECURITY_EVENT:${event.ruleId}]`, JSON.stringify(fullEvent));

    try {
      const supabase = clientOverride || createAdminClient();
      if (supabase && typeof (supabase as any).from === 'function') {
        (supabase as any)
          .from('telecom_security_events')
          .insert({
            organization_id: event.organizationId || null,
            provider_account_id: event.providerAccountId || null,
            rule_id: event.ruleId,
            service: event.service || null,
            intent: event.intent || null,
            details: sanitizedDetails,
            created_at: fullEvent.timestamp,
          })
          .then(
            () => {},
            (err: any) => {
              if (process.env.NODE_ENV !== 'test') {
                console.warn('[ProviderAccountResolver] Notice: Security event table write bypassed/failed:', err?.message || err);
              }
            }
          );
      }
    } catch {
      // Non-blocking catch for standalone environments
    }
  }

  static getSecurityEvents(): ProviderSecurityEvent[] {
    return [...this.securityEvents];
  }

  static async getDurableSecurityEvents(
    organizationId?: string,
    clientOverride?: SupabaseClient
  ): Promise<ProviderSecurityEvent[]> {
    try {
      const supabase = clientOverride || createAdminClient();
      let query = (supabase as any)
        .from('telecom_security_events')
        .select('*')
        .order('created_at', { ascending: false });

      if (organizationId) {
        query = query.eq('organization_id', organizationId);
      }

      const { data, error } = await query;
      if (error || !data) return [];
      return data.map((row: any) => ({
        ruleId: row.rule_id,
        organizationId: row.organization_id || undefined,
        providerAccountId: row.provider_account_id || undefined,
        service: row.service || undefined,
        intent: row.intent || undefined,
        details: row.details || {},
        timestamp: row.created_at,
      }));
    } catch {
      return [];
    }
  }

  static clearSecurityEvents(): void {
    this.securityEvents = [];
  }

  /**
   * Resolves the authoritative telecom provider account context for an organization.
   * Fails closed on any unknown organization, missing assignment, inactive account,
   * or attempted access to SHARED_PARENT.
   * Browser/client payload overrides are strictly prohibited.
   */
  static async resolveAccount(
    params: ResolveProviderAccountParams,
    clientOverride?: SupabaseClient
  ): Promise<ProviderResolutionResult> {
    return this.resolveProviderAccount(params, clientOverride);
  }

  /**
   * Authoritative platform administrative account resolver.
   * Can ONLY be invoked by trusted server-side administrative code (e.g., subaccount provisioning).
   * Strictly isolated from tenant customer runtime.
   */
  static async resolvePlatformAdminAccount(
    params: ResolvePlatformAdminAccountParams,
    clientOverride?: SupabaseClient
  ): Promise<ProviderResolutionResult> {
    const {
      service,
      environment,
      expectedProvider,
      clientPayloadProviderOverride,
      clientPayloadIntentOverride,
    } = params;

    // 1. Strict Security Gate: Reject client payload overrides
    if (clientPayloadProviderOverride || clientPayloadIntentOverride) {
      this.emitSecurityEvent({
        ruleId: 'CLIENT_OVERRIDE_ATTEMPT',
        service,
        intent: 'PLATFORM_ADMIN',
        details: { clientPayloadProviderOverride, clientPayloadIntentOverride },
      });
      return {
        success: false,
        errorCode: 'CLIENT_OVERRIDE_PROHIBITED',
        errorMessage: 'Client payload override is strictly prohibited. Administrative resolution is server-side only.',
      };
    }

    const supabase = clientOverride || createAdminClient();

    try {
      // Query authoritative shared parent account
      const { data: parentAccounts, error: queryErr } = await (supabase as any)
        .from('telecom_provider_accounts')
        .select('*')
        .eq('account_type', 'SHARED_PARENT');

      if (queryErr) {
        return {
          success: false,
          errorCode: 'DATABASE_ERROR',
          errorMessage: `Failed to query parent administrative provider account: ${queryErr.message}`,
        };
      }

      let parentAccount = parentAccounts && parentAccounts.length > 0 ? parentAccounts[0] : null;

      // Fallback lookup by SHARED_PARENT_TWILIO_ID if query by type didn't match
      if (!parentAccount) {
        const { data: byId } = await (supabase as any)
          .from('telecom_provider_accounts')
          .select('*')
          .eq('id', SHARED_PARENT_TWILIO_ID)
          .maybeSingle();
        if (byId && byId.account_type === 'SHARED_PARENT') {
          parentAccount = byId;
        }
      }

      if (!parentAccount) {
        return {
          success: false,
          errorCode: 'UNKNOWN_OR_INACTIVE_PROVIDER',
          errorMessage: 'Shared parent administrative provider account was not found.',
        };
      }

      if (parentAccount.status !== 'active') {
        return {
          success: false,
          errorCode: 'PROVIDER_ACCOUNT_INACTIVE',
          errorMessage: `Parent administrative provider account '${parentAccount.id}' is inactive (status: ${parentAccount.status}).`,
        };
      }

      const caps: TelecomServiceScope[] = parentAccount.capabilities || [];
      if (!caps.includes('ALL') && !caps.includes(service)) {
        return {
          success: false,
          errorCode: 'CAPABILITY_UNSUPPORTED',
          errorMessage: `Parent administrative account does not support service scope '${service}'.`,
        };
      }

      if (expectedProvider && parentAccount.provider !== expectedProvider) {
        return {
          success: false,
          errorCode: 'PROVIDER_MISMATCH',
          errorMessage: `Provider mismatch: expected '${expectedProvider}', got '${parentAccount.provider}'.`,
        };
      }

      if (environment && parentAccount.environment !== environment) {
        return {
          success: false,
          errorCode: 'PROVIDER_ENVIRONMENT_MISMATCH',
          errorMessage: `Environment mismatch: expected '${environment}', got '${parentAccount.environment}'.`,
        };
      }

      return {
        success: true,
        context: {
          providerAccountId: parentAccount.id,
          provider: parentAccount.provider,
          accountType: 'SHARED_PARENT',
          accountReference: parentAccount.account_reference || SHARED_PARENT_ACCOUNT_REFERENCE,
          credentialReference: parentAccount.credential_reference || 'env:TWILIO_ACCOUNT_SID',
          organizationId: PLATFORM_ADMIN_ORGANIZATION_ID,
          serviceScope: service,
          countryCode: null,
          environment: parentAccount.environment || 'production',
          capabilities: caps,
          isSharedParent: true,
          metadata: parentAccount.metadata || {},
        },
      };
    } catch (err: any) {
      return {
        success: false,
        errorCode: 'UNKNOWN_OR_INACTIVE_PROVIDER',
        errorMessage: `Exception resolving platform admin account: ${err?.message || err}`,
      };
    }
  }

  static async resolveProviderAccount(
    params: ResolveProviderAccountParams,
    clientOverride?: SupabaseClient
  ): Promise<ProviderResolutionResult> {
    const {
      organizationId,
      service,
      countryCode,
      intent = 'CUSTOMER_RUNTIME',
      expectedProvider,
      environment,
      strictMode = true,
      _dangerouslyPermitNonStrict = false,
      clientPayloadProviderOverride,
      clientPayloadIntentOverride,
    } = params;

    // Phase 24D.SEC-7F M-01 Invariant: Customer runtime MUST fail closed in strictMode (default: true).
    // Permissive non-strict resolution is disallowed for tenant customer runtime without explicit administrative opt-out.
    if (intent === 'CUSTOMER_RUNTIME' && !strictMode && !_dangerouslyPermitNonStrict) {
      this.emitSecurityEvent({
        ruleId: 'CUSTOMER_STRICT_RESOLUTION_VIOLATION',
        organizationId,
        service,
        intent,
        details: { reason: 'NON_STRICT_CUSTOMER_RESOLUTION_PROHIBITED' },
      });
      return {
        success: false,
        errorCode: 'STRICT_RESOLUTION_REQUIRED',
        errorMessage: 'Customer tenant operations require strict provider resolution. Permissive non-strict resolution is strictly prohibited for customer runtime.',
      };
    }

    // 1. Strict Security Gate: Client payload must NEVER choose or override provider or intent
    if (clientPayloadProviderOverride || clientPayloadIntentOverride) {
      this.emitSecurityEvent({
        ruleId: 'CLIENT_OVERRIDE_ATTEMPT',
        organizationId,
        service,
        intent,
        details: { clientPayloadProviderOverride, clientPayloadIntentOverride },
      });
      return {
        success: false,
        errorCode: 'CLIENT_OVERRIDE_PROHIBITED',
        errorMessage: 'Client payload provider or intent override is strictly prohibited. Provider resolution is server-side only.',
      };
    }

    // 2. Intent Routing: Handle PLATFORM_ADMIN vs CUSTOMER_RUNTIME
    if (intent === 'PLATFORM_ADMIN') {
      // Security Invariant: A tenant customer organization cannot request PLATFORM_ADMIN
      if (organizationId && organizationId !== PLATFORM_ADMIN_ORGANIZATION_ID) {
        this.emitSecurityEvent({
          ruleId: 'PARENT_ACCOUNT_CUSTOMER_ACCESS_BLOCKED',
          organizationId,
          service,
          intent,
          details: { reason: 'CUSTOMER_TENANT_CANNOT_REQUEST_PLATFORM_ADMIN' },
        });
        return {
          success: false,
          errorCode: 'INVALID_RESOLUTION_INTENT',
          errorMessage: `Tenant customer organization '${organizationId}' cannot request PLATFORM_ADMIN resolution intent.`,
        };
      }

      return this.resolvePlatformAdminAccount(
        {
          service,
          environment,
          expectedProvider,
          clientPayloadProviderOverride,
          clientPayloadIntentOverride,
        },
        clientOverride
      );
    }

    // CUSTOMER_RUNTIME validation
    if (!organizationId || typeof organizationId !== 'string' || organizationId.trim() === '') {
      return {
        success: false,
        errorCode: 'UNKNOWN_ORGANIZATION',
        errorMessage: 'Invalid or missing organization identifier.',
      };
    }

    const supabase = clientOverride || createAdminClient();

    // 3. Authoritative Organization Existence Check
    try {
      const { data: orgData, error: orgError } = await (supabase as any)
        .from('organizations')
        .select('id, name')
        .eq('id', organizationId)
        .maybeSingle();

      if (orgError || !orgData) {
        return {
          success: false,
          errorCode: 'UNKNOWN_ORGANIZATION',
          errorMessage: `Organization '${organizationId}' does not exist or access is denied.`,
        };
      }
    } catch (err: any) {
      return {
        success: false,
        errorCode: 'UNKNOWN_ORGANIZATION',
        errorMessage: `Failed to verify organization: ${err?.message || err}`,
      };
    }

    // 4. Query Active Provider Assignments for Organization
    try {
      const { data: assignments, error: assignError } = await (supabase as any)
        .from('telecom_organization_provider_assignments')
        .select(`
          id,
          organization_id,
          provider_account_id,
          service_scope,
          country_code,
          priority,
          is_active,
          metadata
        `)
        .eq('organization_id', organizationId);

      if (assignError) {
        this.emitSecurityEvent({
          ruleId: 'PROVIDER_ASSIGNMENT_MISSING',
          organizationId,
          service,
          intent,
          details: { error: assignError.message },
        });
        return {
          success: false,
          errorCode: 'PROVIDER_ASSIGNMENT_REQUIRED',
          errorMessage: `Database error querying provider assignments for organization '${organizationId}': ${assignError.message}`,
        };
      }

      if (assignments && assignments.length > 0) {
        // Filter assignments matching requested service scope ('ALL' or specific service)
        const scopedAssignments = assignments.filter((a: any) =>
          a.service_scope === 'ALL' || a.service_scope === service
        );

        if (scopedAssignments.length > 0) {
          // Score by country match specificity and priority
          const scored = scopedAssignments.map((a: any) => {
            let specificity = 0;
            if (countryCode && a.country_code) {
              if (a.country_code.toUpperCase() === countryCode.toUpperCase()) {
                specificity = 2; // Exact country match
              } else {
                specificity = -1; // Country mismatch
              }
            } else if (!a.country_code) {
              specificity = 1; // Generic country fallback
            }

            return {
              ...a,
              specificity,
              effectiveScore: specificity * 1000 + (a.priority || 100),
            };
          }).filter((a: any) => a.specificity >= 0);

          if (scored.length > 0) {
            // Sort highest effective score first
            scored.sort((a: any, b: any) => b.effectiveScore - a.effectiveScore);

            const highestScore = scored[0].effectiveScore;
            const topCandidates = scored.filter((a: any) => a.effectiveScore === highestScore);

            // Ambiguity check: Multiple distinct provider accounts at identical highest score
            const uniqueAccountIds = Array.from(new Set(topCandidates.map((c: any) => c.provider_account_id)));
            if (uniqueAccountIds.length > 1) {
              return {
                success: false,
                errorCode: 'AMBIGUOUS_PROVIDER_ASSIGNMENT',
                errorMessage: `Ambiguous provider assignment: multiple active provider accounts conflict with identical priority for scope '${service}'.`,
              };
            }

            const chosenAssignment = topCandidates[0];

            // Inactive / Suspended Assignment Check: Fail closed immediately, NEVER silently fall back!
            if (!chosenAssignment.is_active) {
              this.emitSecurityEvent({
                ruleId: 'PROVIDER_ACCOUNT_INACTIVE',
                organizationId,
                providerAccountId: chosenAssignment.provider_account_id,
                service,
                intent,
                details: { assignmentId: chosenAssignment.id, isActive: false },
              });
              return {
                success: false,
                errorCode: 'UNKNOWN_OR_INACTIVE_PROVIDER',
                errorMessage: `Explicit provider assignment for scope '${service}' (ID: ${chosenAssignment.id}) is suspended or inactive. Cannot fall back.`,
              };
            }

            // Fetch the assigned provider account record
            const { data: accountRow, error: accountErr } = await (supabase as any)
              .from('telecom_provider_accounts')
              .select('*')
              .eq('id', chosenAssignment.provider_account_id)
              .maybeSingle();

            if (accountErr || !accountRow) {
              this.emitSecurityEvent({
                ruleId: 'PROVIDER_ACCOUNT_INACTIVE',
                organizationId,
                providerAccountId: chosenAssignment.provider_account_id,
                service,
                intent,
                details: { error: accountErr?.message || 'NOT_FOUND' },
              });
              return {
                success: false,
                errorCode: 'UNKNOWN_OR_INACTIVE_PROVIDER',
                errorMessage: `Assigned provider account '${chosenAssignment.provider_account_id}' was not found. Cannot fall back.`,
              };
            }

            if (accountRow.status !== 'active') {
              this.emitSecurityEvent({
                ruleId: 'PROVIDER_ACCOUNT_INACTIVE',
                organizationId,
                providerAccountId: chosenAssignment.provider_account_id,
                service,
                intent,
                details: { status: accountRow.status },
              });
              return {
                success: false,
                errorCode: 'UNKNOWN_OR_INACTIVE_PROVIDER',
                errorMessage: `Assigned provider account '${chosenAssignment.provider_account_id}' is inactive (status: ${accountRow.status}). Cannot fall back.`,
              };
            }

            // CRITICAL TYPE 1 INVARIANT: Customer organization assignment to SHARED_PARENT is strictly prohibited!
            if (accountRow.account_type === 'SHARED_PARENT') {
              this.emitSecurityEvent({
                ruleId: 'PARENT_ACCOUNT_CUSTOMER_ACCESS_BLOCKED',
                organizationId,
                providerAccountId: accountRow.id,
                service,
                intent,
                details: { accountReference: accountRow.account_reference },
              });
              return {
                success: false,
                errorCode: 'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED',
                errorMessage: `Customer organization assignment to SHARED_PARENT account '${accountRow.id}' is strictly prohibited. Customer runtime must be backed by CUSTOMER_SUBACCOUNT or DEDICATED_ACCOUNT.`,
              };
            }

            if (accountRow.account_type !== 'CUSTOMER_SUBACCOUNT' && accountRow.account_type !== 'DEDICATED_ACCOUNT') {
              this.emitSecurityEvent({
                ruleId: 'MALFORMED_PROVIDER_RECORD',
                organizationId,
                providerAccountId: accountRow.id,
                service,
                intent,
                details: { accountType: accountRow.account_type },
              });
              return {
                success: false,
                errorCode: 'MALFORMED_PROVIDER_ACCOUNT',
                errorMessage: `Assigned provider account '${accountRow.id}' has unsupported account type '${accountRow.account_type}'. Customer runtime requires CUSTOMER_SUBACCOUNT or DEDICATED_ACCOUNT.`,
              };
            }

            // Verify Capability
            const caps: TelecomServiceScope[] = accountRow.capabilities || [];
            if (!caps.includes('ALL') && !caps.includes(service)) {
              return {
                success: false,
                errorCode: 'CAPABILITY_UNSUPPORTED',
                errorMessage: `Provider account '${accountRow.account_reference}' does not support service scope '${service}'. Cannot fall back.`,
              };
            }

            // Verify Provider Match if specified
            if (expectedProvider && accountRow.provider !== expectedProvider) {
              return {
                success: false,
                errorCode: 'PROVIDER_MISMATCH',
                errorMessage: `Provider mismatch: expected '${expectedProvider}', got '${accountRow.provider}'.`,
              };
            }

            // Verify Environment Match if specified
            if (environment && accountRow.environment !== environment) {
              this.emitSecurityEvent({
                ruleId: 'PROVIDER_ACCOUNT_ENVIRONMENT_MISMATCH',
                organizationId,
                providerAccountId: accountRow.id,
                service,
                intent,
                details: { expectedEnvironment: environment, actualEnvironment: accountRow.environment },
              });
              return {
                success: false,
                errorCode: 'PROVIDER_ENVIRONMENT_MISMATCH',
                errorMessage: `Environment mismatch: expected '${environment}', got '${accountRow.environment}'.`,
              };
            }

            // Verify Account and Credential References
            if (!accountRow.account_reference || !accountRow.credential_reference) {
              this.emitSecurityEvent({
                ruleId: 'MALFORMED_PROVIDER_RECORD',
                organizationId,
                providerAccountId: accountRow.id,
                service,
                intent,
                details: {
                  hasAccountRef: Boolean(accountRow.account_reference),
                  hasCredRef: Boolean(accountRow.credential_reference),
                },
              });
              return {
                success: false,
                errorCode: 'MALFORMED_PROVIDER_ACCOUNT',
                errorMessage: `Provider account '${accountRow.id}' has missing required account reference or credential reference.`,
              };
            }

            return {
              success: true,
              context: {
                providerAccountId: accountRow.id,
                provider: accountRow.provider,
                accountType: accountRow.account_type,
                accountReference: accountRow.account_reference,
                credentialReference: accountRow.credential_reference,
                organizationId,
                serviceScope: service,
                countryCode: chosenAssignment.country_code || null,
                environment: accountRow.environment || 'production',
                capabilities: caps,
                isSharedParent: false, // In CUSTOMER_RUNTIME this is NEVER true!
                metadata: accountRow.metadata || {},
              },
            };
          } else {
            // Organization has explicit custom assignments for this service, but none match the requested country!
            // Fail closed rather than silently falling back to shared parent!
            this.emitSecurityEvent({
              ruleId: 'PROVIDER_ASSIGNMENT_MISSING',
              organizationId,
              service,
              intent,
              details: { countryCode, reason: 'COUNTRY_MISMATCH' },
            });
            return {
              success: false,
              errorCode: 'MISSING_PROVIDER_ASSIGNMENT',
              errorMessage: `No provider assignment configured for organization '${organizationId}', service '${service}', and country '${countryCode}'. Cannot silently hop providers.`,
            };
          }
        }
      }
    } catch (err: any) {
      console.warn('[ProviderAccountResolver] Exception evaluating assignments:', err?.message || err);
      return {
        success: false,
        errorCode: 'PROVIDER_ASSIGNMENT_REQUIRED',
        errorMessage: `Exception querying provider assignments: ${err?.message || err}`,
      };
    }

    // 5. Final Fail Closed Gate: No valid provider account assignment found for customer organization
    // STRICT TYPE 1 INVARIANT: Zero fallback to SHARED_PARENT for customer runtime!
    this.emitSecurityEvent({
      ruleId: 'PROVIDER_ASSIGNMENT_MISSING',
      organizationId,
      service,
      intent,
      details: { strictMode },
    });

    return {
      success: false,
      errorCode: 'PROVIDER_ASSIGNMENT_REQUIRED',
      errorMessage: `No active provider account assignment found for organization '${organizationId}' and service '${service}'. Customer operations cannot fall back to shared parent.`,
    };
  }


  /**
   * Resolves a provider account strictly from an untrusted AccountSid lookup hint.
   *
   * SECURITY INVARIANTS:
   * - AccountSid is an untrusted hint until signature validation succeeds.
   * - Missing, unknown, inactive, suspended, or ambiguous AccountSids FAIL CLOSED.
   * - No silent fallback to parent account for subaccounts.
   */
  static async resolveAccountByAccountSid(
    accountSid: string,
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; account?: any; errorCode?: string; errorMessage?: string }> {
    if (!accountSid || typeof accountSid !== 'string' || accountSid.trim() === '') {
      return {
        success: false,
        errorCode: 'MISSING_ACCOUNT_SID',
        errorMessage: 'Webhook payload missing required AccountSid.',
      };
    }

    const cleanSid = accountSid.trim();
    const supabase = clientOverride || createAdminClient();

    try {
      const envParentSid = process.env.TWILIO_ACCOUNT_SID?.trim();
      const isParentMatch = cleanSid === SHARED_PARENT_ACCOUNT_REFERENCE || (envParentSid && cleanSid === envParentSid);

      // Query telecom_provider_accounts by account_reference
      let query = (supabase as any).from('telecom_provider_accounts').select('*');

      if (isParentMatch) {
        query = query.or(
          `account_reference.eq.${cleanSid},account_reference.eq.${SHARED_PARENT_ACCOUNT_REFERENCE},account_type.eq.SHARED_PARENT`
        );
      } else {
        query = query.eq('account_reference', cleanSid);
      }

      const { data: accounts, error } = await query;
      if (error) {
        return {
          success: false,
          errorCode: 'DATABASE_ERROR',
          errorMessage: error.message,
        };
      }

      if (!accounts || accounts.length === 0) {
        return {
          success: false,
          errorCode: 'UNKNOWN_ACCOUNT_SID',
          errorMessage: `Provider account '${cleanSid}' was not found.`,
        };
      }

      // Ambiguity check
      const uniqueIds = Array.from(new Set(accounts.map((a: any) => a.id)));
      if (uniqueIds.length > 1) {
        return {
          success: false,
          errorCode: 'AMBIGUOUS_PROVIDER_ACCOUNT',
          errorMessage: `Multiple active provider accounts match AccountSid '${cleanSid}'.`,
        };
      }

      const account = accounts[0];

      // Inactive / Suspended Checks
      if (account.status === 'suspended') {
        return {
          success: false,
          errorCode: 'SUSPENDED_PROVIDER_ACCOUNT',
          errorMessage: `Provider account '${cleanSid}' is suspended.`,
        };
      }

      if (account.status !== 'active') {
        return {
          success: false,
          errorCode: 'INACTIVE_PROVIDER_ACCOUNT',
          errorMessage: `Provider account '${cleanSid}' is inactive (status: ${account.status}).`,
        };
      }

      return {
        success: true,
        account,
      };
    } catch (err: any) {
      return {
        success: false,
        errorCode: 'LOOKUP_EXCEPTION',
        errorMessage: err.message || String(err),
      };
    }
  }

  /**
   * Resolves the exact webhook verification Auth Token for a provider account.
   *
   * SECURITY INVARIANTS:
   * - Shared parent accounts resolve from parent environment credentials ONLY if account_type === 'SHARED_PARENT'.
   * - Customer subaccounts resolve from TelecomSecretVault with purpose === 'WEBHOOK_VERIFICATION'.
   * - STRICTLY NO PARENT FALLBACK for customer subaccounts.
   */
  static async resolveWebhookVerificationSecret(
    account: any,
    vaultOverride?: any
  ): Promise<{ success: boolean; secret?: string; purpose?: string; errorCode?: string; errorMessage?: string }> {
    if (!account) {
      return { success: false, errorCode: 'INVALID_ACCOUNT', errorMessage: 'Provider account is null.' };
    }

    // A. Explicit Parent Account
    if (account.account_type === 'SHARED_PARENT') {
      const parentToken = process.env.TWILIO_AUTH_TOKEN?.trim();
      if (!parentToken) {
        return {
          success: false,
          errorCode: 'PARENT_AUTH_TOKEN_MISSING',
          errorMessage: 'Server environment credentials for parent Twilio account are unconfigured.',
        };
      }
      return {
        success: true,
        secret: parentToken,
        purpose: 'WEBHOOK_VERIFICATION',
      };
    }

    // B. Customer Subaccount / Dedicated Account
    // STRICT RULE: NEVER fall back to parent credentials!
    const { TelecomSecretVaultRegistry } = await import('@/lib/telecom/vault');
    const vault = vaultOverride || TelecomSecretVaultRegistry.getVault();

    // Determine credential reference
    const webhookRef =
      account.metadata?.webhook_credential_reference ||
      account.metadata?.webhookCredentialReference ||
      `${account.credential_reference}:webhook`;

    let payload: any = null;

    // 1. Try getSecretByPurpose if supported by vault
    if (vault.getSecretByPurpose) {
      payload = await vault.getSecretByPurpose(account.id, 'WEBHOOK_VERIFICATION');
    }

    // 2. Try explicit webhook reference
    if (!payload && webhookRef) {
      payload = await vault.getSecret(webhookRef);
    }

    // 3. Fall back to base credential_reference
    if (!payload && account.credential_reference) {
      payload = await vault.getSecret(account.credential_reference);
    }

    if (!payload) {
      return {
        success: false,
        errorCode: 'MISSING_VAULT_SECRET',
        errorMessage: `Webhook verification secret not found for provider account '${account.account_reference}'.`,
      };
    }

    // Validate Status
    if (payload.metadata.status === 'revoked') {
      return {
        success: false,
        errorCode: 'CREDENTIAL_REVOKED',
        errorMessage: `Webhook verification credential for account '${account.account_reference}' is revoked.`,
      };
    }

    if (payload.metadata.status !== 'active') {
      return {
        success: false,
        errorCode: 'CREDENTIAL_INACTIVE',
        errorMessage: `Webhook verification credential for account '${account.account_reference}' is not active (status: ${payload.metadata.status}).`,
      };
    }

    // Validate Account Ownership
    if (payload.metadata.providerAccountId !== account.id) {
      return {
        success: false,
        errorCode: 'CREDENTIAL_ACCOUNT_MISMATCH',
        errorMessage: `Credential reference belongs to account '${payload.metadata.providerAccountId}', not '${account.id}'.`,
      };
    }

    // Validate Credential Purpose: MUST be WEBHOOK_VERIFICATION or GENERAL
    const purpose = payload.metadata.purpose;
    if (!purpose || (purpose !== 'WEBHOOK_VERIFICATION' && purpose !== 'GENERAL')) {
      return {
        success: false,
        errorCode: 'WRONG_CREDENTIAL_PURPOSE',
        errorMessage: `Credential purpose is '${purpose || 'UNSPECIFIED'}', expected 'WEBHOOK_VERIFICATION'.`,
      };
    }

    if (!payload.secret || payload.secret.trim() === '') {
      return {
        success: false,
        errorCode: 'AUTH_TOKEN_EMPTY',
        errorMessage: 'Webhook verification secret value is empty.',
      };
    }

    return {
      success: true,
      secret: payload.secret.trim(),
      purpose: payload.metadata.purpose || 'WEBHOOK_VERIFICATION',
    };
  }

  /**
   * Resolves the WebRTC signing credentials (API Key SID + Secret + TwiML App SID)
   * for a dedicated customer provider account.
   *
   * SECURITY INVARIANTS:
   * - ONLY CUSTOMER_SUBACCOUNT or DEDICATED_ACCOUNT may be resolved.
   * - SHARED_PARENT accounts are STRICTLY PROHIBITED for customer WebRTC token signing.
   * - API Key must belong to the resolved subaccount (providerAccountId match).
   * - API Key must be active (not revoked, not suspended).
   * - API Key purpose separation: MUST NOT be WEBHOOK_VERIFICATION.
   * - TwiML App must be dedicated to this subaccount.
   * - ZERO FALLBACK to parent credentials.
   */
  static async resolveWebRtcSigningCredentials(
    account: any,
    vaultOverride?: any
  ): Promise<{
    success: boolean;
    apiKeySid?: string;
    apiKeySecret?: string;
    twimlAppSid?: string;
    subaccountSid?: string;
    purpose?: string;
    errorCode?: string;
    errorMessage?: string;
  }> {
    if (!account) {
      return { success: false, errorCode: 'INVALID_ACCOUNT', errorMessage: 'Provider account is null.' };
    }

    // 1. Shared Parent Prohibition
    if (account.account_type === 'SHARED_PARENT') {
      return {
        success: false,
        errorCode: 'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED',
        errorMessage: 'Customer WebRTC tokens may never be generated from shared parent credentials.',
      };
    }

    if (account.account_type !== 'CUSTOMER_SUBACCOUNT' && account.account_type !== 'DEDICATED_ACCOUNT') {
      return {
        success: false,
        errorCode: 'INVALID_PROVIDER_ACCOUNT_TYPE',
        errorMessage: `Provider account type '${account.account_type}' does not support customer WebRTC calling.`,
      };
    }

    // 2. Active Status
    if (account.status !== 'active') {
      return {
        success: false,
        errorCode: 'PROVIDER_ACCOUNT_INACTIVE',
        errorMessage: `Provider account '${account.account_reference}' is not active (status: ${account.status}).`,
      };
    }

    const subaccountSid = account.account_reference?.trim();
    if (!subaccountSid || !subaccountSid.startsWith('AC')) {
      return {
        success: false,
        errorCode: 'INVALID_ACCOUNT_REFERENCE',
        errorMessage: `Subaccount SID '${subaccountSid}' is missing or malformed (expected AC... format).`,
      };
    }

    // 3. Resolve Dedicated Subaccount TwiML App SID
    const metadata = account.metadata || {};
    const twimlAppSid = (
      metadata.twiml_app_sid ||
      metadata.twimlAppSid ||
      metadata.voice_app_sid ||
      metadata.voiceAppSid ||
      ''
    ).trim();

    if (!twimlAppSid) {
      return {
        success: false,
        errorCode: 'CUSTOMER_SUBACCOUNT_WEBRTC_UNSUPPORTED',
        errorMessage:
          'Customer subaccount WebRTC calling requires dedicated per-subaccount TwiML App and API key provisioning which has not yet been provisioned. Parent token fallback is strictly prohibited.',
      };
    }

    if (!twimlAppSid.startsWith('AP')) {
      return {
        success: false,
        errorCode: 'INVALID_TWIML_APP_SID',
        errorMessage: `TwiML App SID '${twimlAppSid}' is malformed (expected AP... format).`,
      };
    }

    // TwiML App Account Binding Check
    if (metadata.twiml_app_account_sid && metadata.twiml_app_account_sid.trim() !== subaccountSid) {
      return {
        success: false,
        errorCode: 'CROSS_ACCOUNT_TWIML_APP_MISMATCH',
        errorMessage: `TwiML App SID belongs to account '${metadata.twiml_app_account_sid}', not resolved subaccount '${subaccountSid}'.`,
      };
    }

    // 4. Resolve WebRTC Token Signing API Key from Vault
    try {
      const { TelecomSecretVaultRegistry } = await import('@/lib/telecom/vault');
      const vault = vaultOverride || TelecomSecretVaultRegistry.getVault();

      if (!vault) {
        return {
          success: false,
          errorCode: 'VAULT_UNAVAILABLE',
          errorMessage: 'TelecomSecretVault is unavailable.',
        };
      }

      let payload: any = null;

      // a. Try explicit WEBRTC_TOKEN_SIGNING purpose
      if (vault.getSecretByPurpose) {
        payload = await vault.getSecretByPurpose(account.id, 'WEBRTC_TOKEN_SIGNING');
      }

      // b. Try webrtc_credential_reference in account metadata
      const webrtcRef = metadata.webrtc_credential_reference || metadata.webrtcCredentialReference;
      if (!payload && webrtcRef) {
        payload = await vault.getSecret(webrtcRef);
      }

      // c. Try RUNTIME_API purpose
      if (!payload && vault.getSecretByPurpose) {
        payload = await vault.getSecretByPurpose(account.id, 'RUNTIME_API');
      }

      // d. Try base credential_reference
      if (!payload && account.credential_reference) {
        payload = await vault.getSecret(account.credential_reference);
      }

      if (!payload) {
        return {
          success: false,
          errorCode: 'CUSTOMER_SUBACCOUNT_WEBRTC_UNSUPPORTED',
          errorMessage: `WebRTC signing credential not found in secret vault for subaccount '${account.account_reference}'.`,
        };
      }

      // Validate Credential Status
      if (payload.metadata.status === 'revoked') {
        return {
          success: false,
          errorCode: 'CREDENTIAL_REVOKED',
          errorMessage: `WebRTC signing credential for account '${account.account_reference}' is revoked.`,
        };
      }

      if (payload.metadata.status !== 'active') {
        return {
          success: false,
          errorCode: 'CREDENTIAL_INACTIVE',
          errorMessage: `WebRTC signing credential for account '${account.account_reference}' is not active (status: ${payload.metadata.status}).`,
        };
      }

      // Validate Provider Account Ownership
      if (payload.metadata.providerAccountId !== account.id) {
        return {
          success: false,
          errorCode: 'CROSS_ACCOUNT_CREDENTIAL_MISMATCH',
          errorMessage: `Credential reference belongs to account '${payload.metadata.providerAccountId}', not '${account.id}'.`,
        };
      }

      // Validate Credential Purpose: MUST NOT be WEBHOOK_VERIFICATION
      const credPurpose = payload.metadata.purpose;
      if (credPurpose === 'WEBHOOK_VERIFICATION') {
        return {
          success: false,
          errorCode: 'WRONG_CREDENTIAL_PURPOSE',
          errorMessage: `Credential purpose is 'WEBHOOK_VERIFICATION', cannot be used for WebRTC token signing.`,
        };
      }

      // Extract API Key SID (SK...)
      const apiKeySid = (payload.metadata.keyIdentifier || payload.metadata.key_identifier || '').trim();
      if (!apiKeySid || !apiKeySid.startsWith('SK')) {
        return {
          success: false,
          errorCode: 'INVALID_API_KEY_SID',
          errorMessage: `WebRTC signing requires an API Key SID (SK...), but received: '${apiKeySid || 'NONE'}'.`,
        };
      }

      // Extract API Key Secret
      const apiKeySecret = payload.secret?.trim();
      if (!apiKeySecret) {
        return {
          success: false,
          errorCode: 'MISSING_API_KEY_SECRET',
          errorMessage: 'WebRTC API Key Secret is empty.',
        };
      }

      return {
        success: true,
        apiKeySid,
        apiKeySecret,
        twimlAppSid,
        subaccountSid,
        purpose: credPurpose || 'WEBRTC_TOKEN_SIGNING',
      };
    } catch (vaultErr: any) {
      return {
        success: false,
        errorCode: 'VAULT_UNAVAILABLE',
        errorMessage: vaultErr.message || String(vaultErr),
      };
    }
  }
}
