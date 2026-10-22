import { SupabaseClient } from '@supabase/supabase-js';

export class MessagingConsentService {
  private static readonly OPT_OUT_KEYWORDS = new Set([
    'stop',
    'stopall',
    'unsubscribe',
    'cancel',
    'end',
    'quit',
    'arret',
  ]);

  private static readonly OPT_IN_KEYWORDS = new Set([
    'start',
    'unstop',
    'yes',
  ]);

  private static readonly HELP_KEYWORDS = new Set([
    'help',
    'info',
    'aide',
  ]);

  // In-memory cache for fast recipient opt-out suppression checks
  private static optOutMemoryStore: Map<string, Set<string>> = new Map();

  public static resetState(): void {
    this.optOutMemoryStore.clear();
  }

  /**
   * Analyzes inbound message body for consent-related keywords.
   */
  public static parseInboundKeyword(body: string): 'opt_out' | 'opt_in' | 'help' | null {
    const trimmed = (body || '').trim().toLowerCase();
    // Normalize single-word or leading-word command
    const firstWord = trimmed.split(/\s+/)[0];

    if (this.OPT_OUT_KEYWORDS.has(firstWord) || this.OPT_OUT_KEYWORDS.has(trimmed)) {
      return 'opt_out';
    }
    if (this.OPT_IN_KEYWORDS.has(firstWord) || this.OPT_IN_KEYWORDS.has(trimmed)) {
      return 'opt_in';
    }
    if (this.HELP_KEYWORDS.has(firstWord) || this.HELP_KEYWORDS.has(trimmed)) {
      return 'help';
    }

    return null;
  }

  /**
   * Records recipient consent state (opt-out suppression or opt-in consent).
   */
  public static async recordConsentAction(
    client: SupabaseClient,
    params: {
      organizationId: string;
      recipientPhone: string;
      action: 'opt_out' | 'opt_in';
      keyword?: string;
    }
  ): Promise<boolean> {
    const { organizationId, recipientPhone, action, keyword } = params;
    const nowIso = new Date().toISOString();

    // Update in-memory cache
    let orgOptOuts = this.optOutMemoryStore.get(organizationId);
    if (!orgOptOuts) {
      orgOptOuts = new Set();
      this.optOutMemoryStore.set(organizationId, orgOptOuts);
    }

    if (action === 'opt_out') {
      orgOptOuts.add(recipientPhone);
    } else {
      orgOptOuts.delete(recipientPhone);
    }

    try {
      await client
        .from('telecom_messaging_consents')
        .upsert(
          {
            organization_id: organizationId,
            phone_number: recipientPhone,
            status: action === 'opt_out' ? 'opted_out' : 'opted_in',
            opt_out_keyword: action === 'opt_out' ? keyword : null,
            opted_out_at: action === 'opt_out' ? nowIso : null,
            opted_in_at: action === 'opt_in' ? nowIso : null,
            updated_at: nowIso,
          },
          { onConflict: 'organization_id,phone_number' }
        );
      return true;
    } catch (err: any) {
      // In-memory update still active
      return true;
    }
  }

  /**
   * Evaluates if an outbound recipient has opted out of messaging for this organization.
   */
  public static async isRecipientOptedOut(
    client: SupabaseClient,
    organizationId: string,
    recipientPhone: string
  ): Promise<boolean> {
    // 1. Check in-memory store
    const orgOptOuts = this.optOutMemoryStore.get(organizationId);
    if (orgOptOuts && orgOptOuts.has(recipientPhone)) {
      return true;
    }

    // 2. Check database table
    try {
      const { data } = await client
        .from('telecom_messaging_consents')
        .select('status')
        .eq('organization_id', organizationId)
        .eq('phone_number', recipientPhone)
        .maybeSingle();

      if (data && data.status === 'opted_out') {
        if (!orgOptOuts) {
          const newSet = new Set<string>();
          newSet.add(recipientPhone);
          this.optOutMemoryStore.set(organizationId, newSet);
        } else {
          orgOptOuts.add(recipientPhone);
        }
        return true;
      }
    } catch {
      // Fall through to false if table not populated
    }

    return false;
  }
}
