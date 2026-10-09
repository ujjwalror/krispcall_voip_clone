import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { hasEntitlement } from '@/lib/entitlements/server';

export type DestinationType = 'user' | 'ivr' | 'voicemail' | 'call_queue' | 'hangup';
export type InboundRoutingType = 'user' | 'ivr' | 'voicemail' | 'call_queue';

export interface IvrMenuDTO {
  id: string;
  organizationId: string;
  name: string;
  enabled: boolean;
  greetingType: 'tts' | 'audio_url';
  greetingText: string;
  greetingAudioUrl: string | null;
  timeoutSeconds: number;
  maxRetries: number;
  timeoutDestinationType: DestinationType;
  timeoutDestinationId: string | null;
  fallbackDestinationType: DestinationType;
  fallbackDestinationId: string | null;
  createdAt: string;
  updatedAt: string;
  options?: IvrOptionDTO[];
}

export interface IvrOptionDTO {
  id: string;
  organizationId: string;
  ivrMenuId: string;
  digit: string;
  destinationType: DestinationType;
  destinationId: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export class IvrService {
  /**
   * Resolves inbound routing configuration for a phone number owned by an organization.
   */
  static async getInboundRouting(
    phoneNumberIdOrE164: string,
    clientOverride?: SupabaseClient
  ): Promise<{
    phoneId: string;
    organizationId: string;
    phoneNumber: string;
    routingType: InboundRoutingType;
    destinationId: string | null;
    active: boolean;
  } | null> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    let query = (supabase as any).from('phone_numbers').select('id, organization_id, phone_number, inbound_routing_type, inbound_routing_destination_id, active');

    if (phoneNumberIdOrE164.startsWith('+') || /^\d+$/.test(phoneNumberIdOrE164)) {
      query = query.eq('phone_number', phoneNumberIdOrE164);
    } else {
      query = query.eq('id', phoneNumberIdOrE164);
    }

    const { data: phone, error } = await query.maybeSingle();

    if (error || !phone) {
      return null;
    }

    return {
      phoneId: phone.id,
      organizationId: phone.organization_id,
      phoneNumber: phone.phone_number,
      routingType: (phone.inbound_routing_type || 'user') as InboundRoutingType,
      destinationId: phone.inbound_routing_destination_id || null,
      active: phone.active !== false,
    };
  }

  /**
   * Assigns inbound routing configuration to an organization-owned phone number.
   * Enforces organization ownership of both phone number and destination resource.
   */
  static async setInboundRouting(
    organizationId: string,
    phoneId: string,
    routingType: InboundRoutingType,
    destinationId: string | null,
    unansweredStrategyOrClient?: string | SupabaseClient,
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; message: string }> {
    let unansweredStrategy: string | undefined;
    let supabase: SupabaseClient;

    if (typeof unansweredStrategyOrClient === 'string') {
      unansweredStrategy = unansweredStrategyOrClient;
      supabase = clientOverride || (await createServerSupabaseClient());
    } else if (unansweredStrategyOrClient && typeof (unansweredStrategyOrClient as any).from === 'function') {
      supabase = unansweredStrategyOrClient as SupabaseClient;
    } else {
      supabase = clientOverride || (await createServerSupabaseClient());
    }

    // 1. Verify phone number belongs to organization and is active
    const { data: phone } = await (supabase as any)
      .from('phone_numbers')
      .select('id, organization_id, active')
      .eq('id', phoneId)
      .maybeSingle();

    if (!phone || phone.organization_id !== organizationId || phone.active === false) {
      return { success: false, message: 'Phone number not found or does not belong to your organization.' };
    }

    // 1b. Reject external forwarding routing strategy (Phase 19D.3 feature)
    if ((routingType as string) === 'forward' || (routingType as string) === 'forward_unavailable') {
      return { success: false, message: 'External call forwarding backend is unavailable (Phase 19D.3 feature).' };
    }

    // 2. Enforce IVR feature entitlement if routingType is 'ivr'
    if (routingType === 'ivr') {
      const entitled = await hasEntitlement('ivr', supabase);
      if (!entitled) {
        return { success: false, message: 'IVR feature is under development or not enabled for your subscription plan.' };
      }
    }

    // 2b. Enforce Voicemail feature entitlement if routingType or unanswered strategy is 'voicemail'
    if (routingType === 'voicemail' || (unansweredStrategy && unansweredStrategy === 'voicemail')) {
      const vmEntitled = await hasEntitlement('voicemail', supabase);
      if (!vmEntitled) {
        return { success: false, message: 'Voicemail feature is not enabled for your subscription plan.' };
      }
    }

    // 3. Validate destination resource ownership
    if (destinationId) {
      if (routingType === 'user') {
        const { data: userProfile } = await (supabase as any)
          .from('profiles')
          .select('id, organization_id, active')
          .eq('id', destinationId)
          .maybeSingle();

        if (!userProfile || userProfile.organization_id !== organizationId || userProfile.active === false) {
          return { success: false, message: 'Target destination user does not belong to your organization or is inactive.' };
        }
      } else if (routingType === 'ivr') {
        const { data: menu } = await (supabase as any)
          .from('ivr_menus')
          .select('id, organization_id, enabled')
          .eq('id', destinationId)
          .maybeSingle();

        if (!menu || menu.organization_id !== organizationId || menu.enabled === false) {
          return { success: false, message: 'Target IVR menu does not belong to your organization or is disabled.' };
        }
      } else if (routingType === 'call_queue') {
        const { data: queue } = await (supabase as any)
          .from('call_queues')
          .select('id, organization_id, enabled')
          .eq('id', destinationId)
          .maybeSingle();

        if (!queue || queue.organization_id !== organizationId || queue.enabled === false) {
          return { success: false, message: 'Target Call Queue does not belong to your organization or is disabled.' };
        }
      }
    }

    // 4. Update inbound routing configuration on phone number
    const updatePayload: Record<string, any> = {
      inbound_routing_type: routingType,
      inbound_routing_destination_id: destinationId,
      inbound_routing_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (unansweredStrategy) {
      updatePayload.unanswered_call_strategy = unansweredStrategy;
    }

    const { error: updateErr } = await (supabase as any)
      .from('phone_numbers')
      .update(updatePayload)
      .eq('id', phoneId)
      .eq('organization_id', organizationId);

    if (updateErr) {
      return { success: false, message: `Failed to update phone routing: ${updateErr.message}` };
    }

    return { success: true, message: 'Inbound routing configuration saved successfully.' };
  }

  /**
   * Lists all IVR menus for an organization.
   */
  static async listIvrMenus(
    organizationId: string,
    clientOverride?: SupabaseClient
  ): Promise<IvrMenuDTO[]> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    const { data: menus, error } = await (supabase as any)
      .from('ivr_menus')
      .select('*, ivr_options(*)')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (error || !menus) {
      return [];
    }

    return menus.map((m: any) => this.mapMenuRow(m));
  }

  /**
   * Fetches a single IVR menu with options.
   */
  static async getIvrMenu(
    organizationId: string,
    menuId: string,
    clientOverride?: SupabaseClient
  ): Promise<IvrMenuDTO | null> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    const { data: menu, error } = await (supabase as any)
      .from('ivr_menus')
      .select('*, ivr_options(*)')
      .eq('id', menuId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error || !menu) {
      return null;
    }

    return this.mapMenuRow(menu);
  }

  /**
   * Creates a new IVR menu for an organization.
  /**
   * Helper to validate a destination type and destination ID.
   */
  private static async validateDestination(
    organizationId: string,
    destType: DestinationType,
    destId: string | null | undefined,
    currentMenuId: string | null,
    supabase: SupabaseClient
  ): Promise<{ valid: boolean; message: string }> {
    if (destType === 'voicemail') {
      const vmEntitled = await hasEntitlement('voicemail', supabase);
      if (!vmEntitled) {
        return { valid: false, message: 'Voicemail destination is not enabled for your subscription plan.' };
      }
      return { valid: true, message: 'Voicemail destination valid.' };
    }
    if (destType === 'hangup') {
      return { valid: true, message: 'Hangup destination is valid.' };
    }
    if (!destId || !destId.trim()) {
      return { valid: false, message: `Destination ID is required for destination type '${destType}'.` };
    }
    const cleanId = destId.trim();

    if (destType === 'user') {
      const { data: profile } = await (supabase as any)
        .from('profiles')
        .select('id, organization_id, active')
        .eq('id', cleanId)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (!profile || profile.active === false) {
        return { valid: false, message: 'Target team member is inactive, invalid, or belongs to another organization.' };
      }
      return { valid: true, message: 'User destination valid.' };
    }

    if (destType === 'call_queue') {
      const queueEntitled = await hasEntitlement('call_queue', supabase);
      if (!queueEntitled) {
        return { valid: false, message: 'Call Queue feature is not included in your current subscription plan.' };
      }
      const { data: queue } = await (supabase as any)
        .from('call_queues')
        .select('id, organization_id, enabled')
        .eq('id', cleanId)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (!queue || queue.enabled === false) {
        return { valid: false, message: 'Target Call Queue is disabled, invalid, or belongs to another organization.' };
      }
      return { valid: true, message: 'Call Queue destination valid.' };
    }

    if (destType === 'ivr') {
      if (currentMenuId && cleanId === currentMenuId) {
        return { valid: false, message: 'IVR menu cannot route to itself. Direct loop prevented.' };
      }
      const { data: targetMenu } = await (supabase as any)
        .from('ivr_menus')
        .select('id, organization_id, enabled')
        .eq('id', cleanId)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (!targetMenu || targetMenu.enabled === false) {
        return { valid: false, message: 'Target sub-menu is disabled, invalid, or belongs to another organization.' };
      }

      if (currentMenuId) {
        const hasCycle = await this.detectIvrCycle(organizationId, currentMenuId, cleanId, supabase);
        if (hasCycle) {
          return { valid: false, message: 'Nested IVR routing loop detected. Cyclic menu paths are strictly prevented.' };
        }
      }
      return { valid: true, message: 'IVR sub-menu destination valid.' };
    }

    return { valid: false, message: `Unsupported destination type '${destType}'.` };
  }

  /**
   * Creates a new IVR menu for an organization.
   */
  static async createIvrMenu(
    organizationId: string,
    menuData: {
      name: string;
      greetingType?: 'tts' | 'audio_url';
      greetingText?: string;
      greetingAudioUrl?: string | null;
      timeoutSeconds?: number;
      maxRetries?: number;
      timeoutDestinationType?: DestinationType;
      timeoutDestinationId?: string | null;
      fallbackDestinationType?: DestinationType;
      fallbackDestinationId?: string | null;
    },
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; menu?: IvrMenuDTO; message: string }> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    const entitled = await hasEntitlement('ivr', supabase);
    if (!entitled) {
      return { success: false, message: 'IVR feature is under development or not enabled for your subscription plan.' };
    }

    if (!menuData.name || !menuData.name.trim()) {
      return { success: false, message: 'IVR menu name is required.' };
    }

    // Validate timeout destination if provided
    if (menuData.timeoutDestinationType) {
      const tVal = await this.validateDestination(organizationId, menuData.timeoutDestinationType, menuData.timeoutDestinationId, null, supabase);
      if (!tVal.valid) {
        return { success: false, message: `Invalid timeout destination: ${tVal.message}` };
      }
    }

    // Validate fallback destination if provided
    if (menuData.fallbackDestinationType) {
      const fVal = await this.validateDestination(organizationId, menuData.fallbackDestinationType, menuData.fallbackDestinationId, null, supabase);
      if (!fVal.valid) {
        return { success: false, message: `Invalid fallback destination: ${fVal.message}` };
      }
    }

    const { data: newMenu, error } = await (supabase as any)
      .from('ivr_menus')
      .insert({
        organization_id: organizationId,
        name: menuData.name.trim(),
        greeting_type: menuData.greetingType || 'tts',
        greeting_text: menuData.greetingText?.trim() || 'Thank you for calling. Please make a selection.',
        greeting_audio_url: menuData.greetingAudioUrl || null,
        timeout_seconds: Math.max(1, Math.min(30, menuData.timeoutSeconds || 5)),
        max_retries: Math.max(1, Math.min(10, menuData.maxRetries || 3)),
        timeout_destination_type: menuData.timeoutDestinationType || 'user',
        timeout_destination_id: menuData.timeoutDestinationId || null,
        fallback_destination_type: menuData.fallbackDestinationType || 'user',
        fallback_destination_id: menuData.fallbackDestinationId || null,
        enabled: true,
      })
      .select('*')
      .single();

    if (error || !newMenu) {
      return { success: false, message: `Failed to create IVR menu: ${error?.message || 'Database error'}` };
    }

    return {
      success: true,
      menu: this.mapMenuRow(newMenu),
      message: 'IVR menu created successfully.',
    };
  }

  /**
   * Updates an existing IVR menu.
   */
  static async updateIvrMenu(
    organizationId: string,
    menuId: string,
    updates: Partial<IvrMenuDTO>,
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; message: string }> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    const entitled = await hasEntitlement('ivr', supabase);
    if (!entitled) {
      return { success: false, message: 'IVR feature is under development or not enabled for your subscription plan.' };
    }

    if (updates.timeoutDestinationType !== undefined || updates.timeoutDestinationId !== undefined) {
      const destType = updates.timeoutDestinationType || 'user';
      const destId = updates.timeoutDestinationId || null;
      const tVal = await this.validateDestination(organizationId, destType, destId, menuId, supabase);
      if (!tVal.valid) {
        return { success: false, message: `Invalid timeout destination: ${tVal.message}` };
      }
    }

    if (updates.fallbackDestinationType !== undefined || updates.fallbackDestinationId !== undefined) {
      const destType = updates.fallbackDestinationType || 'user';
      const destId = updates.fallbackDestinationId || null;
      const fVal = await this.validateDestination(organizationId, destType, destId, menuId, supabase);
      if (!fVal.valid) {
        return { success: false, message: `Invalid fallback destination: ${fVal.message}` };
      }
    }

    const updateObj: any = { updated_at: new Date().toISOString() };
    if (updates.name !== undefined) updateObj.name = updates.name.trim();
    if (updates.enabled !== undefined) updateObj.enabled = updates.enabled;
    if (updates.greetingType !== undefined) updateObj.greeting_type = updates.greetingType;
    if (updates.greetingText !== undefined) updateObj.greeting_text = updates.greetingText.trim();
    if (updates.greetingAudioUrl !== undefined) updateObj.greeting_audio_url = updates.greetingAudioUrl;
    if (updates.timeoutSeconds !== undefined) updateObj.timeout_seconds = Math.max(1, Math.min(30, updates.timeoutSeconds));
    if (updates.maxRetries !== undefined) updateObj.max_retries = Math.max(1, Math.min(10, updates.maxRetries));
    if (updates.timeoutDestinationType !== undefined) updateObj.timeout_destination_type = updates.timeoutDestinationType;
    if (updates.timeoutDestinationId !== undefined) updateObj.timeout_destination_id = updates.timeoutDestinationId;
    if (updates.fallbackDestinationType !== undefined) updateObj.fallback_destination_type = updates.fallbackDestinationType;
    if (updates.fallbackDestinationId !== undefined) updateObj.fallback_destination_id = updates.fallbackDestinationId;

    const { error } = await (supabase as any)
      .from('ivr_menus')
      .update(updateObj)
      .eq('id', menuId)
      .eq('organization_id', organizationId);

    if (error) {
      return { success: false, message: `Failed to update IVR menu: ${error.message}` };
    }

    return { success: true, message: 'IVR menu updated successfully.' };
  }

  /**
   * Adds or updates a DTMF keypress option on an IVR menu.
   * Validates digits (0-9, *, #), destination type/ID, and checks against graph cycles.
   */
  static async upsertIvrOption(
    organizationId: string,
    menuId: string,
    optionData: {
      digit: string;
      destinationType: DestinationType;
      destinationId?: string | null;
      enabled?: boolean;
    },
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; option?: IvrOptionDTO; message: string }> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    const entitled = await hasEntitlement('ivr', supabase);
    if (!entitled) {
      return { success: false, message: 'IVR feature is under development or not enabled for your subscription plan.' };
    }

    const digitClean = (optionData.digit || '').trim();
    if (!['0','1','2','3','4','5','6','7','8','9','*','#'].includes(digitClean)) {
      return { success: false, message: `Invalid DTMF digit '${digitClean}'. Allowed: 0-9, *, #.` };
    }

    // Verify parent menu belongs to org
    const { data: menu } = await (supabase as any)
      .from('ivr_menus')
      .select('id, organization_id')
      .eq('id', menuId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!menu) {
      return { success: false, message: 'Target IVR menu not found or unauthorized.' };
    }

    // Validate destination
    const destVal = await this.validateDestination(
      organizationId,
      optionData.destinationType,
      optionData.destinationId,
      menuId,
      supabase
    );

    if (!destVal.valid) {
      return { success: false, message: `Invalid option destination: ${destVal.message}` };
    }

    const { data: optionRow, error } = await (supabase as any)
      .from('ivr_options')
      .upsert(
        {
          organization_id: organizationId,
          ivr_menu_id: menuId,
          digit: digitClean,
          destination_type: optionData.destinationType,
          destination_id: optionData.destinationId || null,
          enabled: optionData.enabled !== false,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'ivr_menu_id,digit' }
      )
      .select('*')
      .single();

    if (error || !optionRow) {
      return { success: false, message: `Failed to save IVR option: ${error?.message || 'Database error'}` };
    }

    return {
      success: true,
      option: this.mapOptionRow(optionRow),
      message: `DTMF Option '${digitClean}' saved successfully.`,
    };
  }

  /**
   * Deletes a DTMF option from an IVR menu.
   */
  static async deleteIvrOption(
    organizationId: string,
    menuId: string,
    optionId: string,
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; message: string }> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    const entitled = await hasEntitlement('ivr', supabase);
    if (!entitled) {
      return { success: false, message: 'IVR feature is under development or not enabled for your subscription plan.' };
    }

    const { error } = await (supabase as any)
      .from('ivr_options')
      .delete()
      .eq('id', optionId)
      .eq('ivr_menu_id', menuId)
      .eq('organization_id', organizationId);

    if (error) {
      return { success: false, message: `Failed to delete IVR option: ${error.message}` };
    }

    return { success: true, message: 'IVR option deleted successfully.' };
  }

  /**
   * Traverses nested IVR links to detect cycles (e.g. Menu A -> Menu B -> Menu A).
   */
  private static async detectIvrCycle(
    organizationId: string,
    startMenuId: string,
    targetMenuId: string,
    supabase: SupabaseClient
  ): Promise<boolean> {
    const visited = new Set<string>([startMenuId]);
    let currentId = targetMenuId;

    while (currentId) {
      if (visited.has(currentId)) {
        return true; // Cycle detected!
      }
      visited.add(currentId);

      // Fetch options for currentId that route to type 'ivr'
      const { data: options } = await (supabase as any)
        .from('ivr_options')
        .select('destination_id')
        .eq('ivr_menu_id', currentId)
        .eq('organization_id', organizationId)
        .eq('destination_type', 'ivr')
        .eq('enabled', true);

      if (!options || options.length === 0) {
        break;
      }

      // Check if any option links back to startMenuId
      for (const opt of options) {
        if (opt.destination_id === startMenuId) {
          return true;
        }
      }

      // Advance depth
      currentId = options[0].destination_id;
    }

    return false;
  }

  private static mapMenuRow(row: any): IvrMenuDTO {
    return {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      enabled: row.enabled !== false,
      greetingType: row.greeting_type || 'tts',
      greetingText: row.greeting_text || '',
      greetingAudioUrl: row.greeting_audio_url || null,
      timeoutSeconds: row.timeout_seconds || 5,
      maxRetries: row.max_retries || 3,
      timeoutDestinationType: row.timeout_destination_type || 'user',
      timeoutDestinationId: row.timeout_destination_id || null,
      fallbackDestinationType: row.fallback_destination_type || 'user',
      fallbackDestinationId: row.fallback_destination_id || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      options: Array.isArray(row.ivr_options) ? row.ivr_options.map((o: any) => this.mapOptionRow(o)) : [],
    };
  }

  private static mapOptionRow(row: any): IvrOptionDTO {
    return {
      id: row.id,
      organizationId: row.organization_id,
      ivrMenuId: row.ivr_menu_id,
      digit: row.digit,
      destinationType: row.destination_type,
      destinationId: row.destination_id || null,
      enabled: row.enabled !== false,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
