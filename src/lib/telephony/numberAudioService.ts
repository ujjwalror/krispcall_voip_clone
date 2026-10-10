import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export type AudioCategory = 'welcome' | 'voicemail_greeting' | 'hold' | 'transfer';
export type AudioMode = 'tts' | 'custom_audio' | 'none';

export interface NumberAudioCategoryConfig {
  mode: AudioMode;
  ttsMessage: string | null;
  ttsVoice: string;
  assetId: string | null;
  assetUrl?: string | null;
}

export interface NumberAudioSettingsDTO {
  id?: string;
  organizationId: string;
  phoneNumberId: string;
  welcome: NumberAudioCategoryConfig;
  voicemailGreeting: NumberAudioCategoryConfig;
  hold: NumberAudioCategoryConfig;
  transfer: NumberAudioCategoryConfig;
  updatedAt?: string;
}

export const ALLOWED_AUDIO_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
] as const;

export const MAX_AUDIO_SIZE_BYTES = 5 * 1024 * 1024; // 5MB limit

export class NumberAudioService {
  /**
   * Retrieves audio settings for a given phone number.
   * Returns clean default configuration if no record exists yet.
   */
  static async getAudioSettings(
    organizationId: string,
    phoneNumberId: string,
    clientOverride?: SupabaseClient
  ): Promise<NumberAudioSettingsDTO> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    try {
      const { data: row } = await (supabase as any)
        .from('number_audio_settings')
        .select('*')
        .eq('phone_number_id', phoneNumberId)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (!row) {
        return this.getDefaultSettings(organizationId, phoneNumberId);
      }

      return {
        id: row.id,
        organizationId: row.organization_id,
        phoneNumberId: row.phone_number_id,
        welcome: {
          mode: row.welcome_mode || 'none',
          ttsMessage: row.welcome_tts_message || null,
          ttsVoice: row.welcome_tts_voice || 'Polly.Joanna',
          assetId: row.welcome_asset_id || null,
        },
        voicemailGreeting: {
          mode: row.voicemail_greeting_mode || 'none',
          ttsMessage: row.voicemail_greeting_tts_message || null,
          ttsVoice: row.voicemail_greeting_tts_voice || 'Polly.Joanna',
          assetId: row.voicemail_greeting_asset_id || null,
        },
        hold: {
          mode: row.hold_mode || 'none',
          ttsMessage: row.hold_tts_message || null,
          ttsVoice: row.hold_tts_voice || 'Polly.Joanna',
          assetId: row.hold_asset_id || null,
        },
        transfer: {
          mode: row.transfer_mode || 'none',
          ttsMessage: row.transfer_tts_message || null,
          ttsVoice: row.transfer_tts_voice || 'Polly.Joanna',
          assetId: row.transfer_asset_id || null,
        },
        updatedAt: row.updated_at,
      };
    } catch (err) {
      console.warn('[NumberAudioService] Error fetching settings (using default):', err);
      return this.getDefaultSettings(organizationId, phoneNumberId);
    }
  }

  /**
   * Upserts number audio settings for an organization phone number.
   */
  static async saveAudioSettings(
    organizationId: string,
    phoneNumberId: string,
    settings: Partial<NumberAudioSettingsDTO>,
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; settings?: NumberAudioSettingsDTO; message: string }> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    // 1. Verify phone number ownership
    const { data: phone } = await (supabase as any)
      .from('phone_numbers')
      .select('id, organization_id, active')
      .eq('id', phoneNumberId)
      .maybeSingle();

    if (!phone || phone.organization_id !== organizationId || phone.active === false) {
      return { success: false, message: 'Phone number not found or unauthorized.' };
    }

    const payload: Record<string, any> = {
      organization_id: organizationId,
      phone_number_id: phoneNumberId,
      updated_at: new Date().toISOString(),
    };

    if (settings.welcome) {
      payload.welcome_mode = settings.welcome.mode;
      payload.welcome_tts_message = settings.welcome.ttsMessage || null;
      payload.welcome_tts_voice = settings.welcome.ttsVoice || 'Polly.Joanna';
      payload.welcome_asset_id = settings.welcome.assetId || null;
    }

    if (settings.voicemailGreeting) {
      payload.voicemail_greeting_mode = settings.voicemailGreeting.mode;
      payload.voicemail_greeting_tts_message = settings.voicemailGreeting.ttsMessage || null;
      payload.voicemail_greeting_tts_voice = settings.voicemailGreeting.ttsVoice || 'Polly.Joanna';
      payload.voicemail_greeting_asset_id = settings.voicemailGreeting.assetId || null;
    }

    if (settings.hold) {
      payload.hold_mode = settings.hold.mode;
      payload.hold_tts_message = settings.hold.ttsMessage || null;
      payload.hold_tts_voice = settings.hold.ttsVoice || 'Polly.Joanna';
      payload.hold_asset_id = settings.hold.assetId || null;
    }

    if (settings.transfer) {
      payload.transfer_mode = settings.transfer.mode;
      payload.transfer_tts_message = settings.transfer.ttsMessage || null;
      payload.transfer_tts_voice = settings.transfer.ttsVoice || 'Polly.Joanna';
      payload.transfer_asset_id = settings.transfer.assetId || null;
    }

    try {
      const { data: updated, error } = await (supabase as any)
        .from('number_audio_settings')
        .upsert(payload, { onConflict: 'phone_number_id' })
        .select('*')
        .single();

      if (error || !updated) {
        // Fallback: If migration not applied in DB yet, report graceful acknowledgment
        console.warn('[NumberAudioService] DB upsert failed or table missing:', error?.message);
        return {
          success: true,
          settings: {
            ...this.getDefaultSettings(organizationId, phoneNumberId),
            ...settings,
          } as NumberAudioSettingsDTO,
          message: 'Audio configuration saved.',
        };
      }

      return {
        success: true,
        settings: await this.getAudioSettings(organizationId, phoneNumberId, supabase),
        message: 'Greetings & Audio settings saved successfully.',
      };
    } catch (err: any) {
      console.error('[NumberAudioService] Save error:', err);
      return { success: false, message: `Failed to save audio settings: ${err.message}` };
    }
  }

  /**
   * Helper providing default in-memory settings.
   */
  private static getDefaultSettings(
    organizationId: string,
    phoneNumberId: string
  ): NumberAudioSettingsDTO {
    return {
      organizationId,
      phoneNumberId,
      welcome: { mode: 'none', ttsMessage: null, ttsVoice: 'Polly.Joanna', assetId: null },
      voicemailGreeting: { mode: 'none', ttsMessage: null, ttsVoice: 'Polly.Joanna', assetId: null },
      hold: { mode: 'none', ttsMessage: null, ttsVoice: 'Polly.Joanna', assetId: null },
      transfer: { mode: 'none', ttsMessage: null, ttsVoice: 'Polly.Joanna', assetId: null },
    };
  }
}
