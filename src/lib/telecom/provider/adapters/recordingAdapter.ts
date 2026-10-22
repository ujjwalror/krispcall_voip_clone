import 'server-only';
import { ProviderContext } from '../types';
import { ProviderClientFactory } from '../providerClientFactory';

export interface RecordingMediaResult {
  ok: boolean;
  status: number;
  data?: ArrayBuffer;
  contentType?: string;
  errorMessage?: string;
}

export interface RecordingProviderAdapter {
  getRecordingStreamUrl(recordingSid: string, context: ProviderContext): string;
  fetchRecordingMedia(recordingSid: string, context: ProviderContext): Promise<RecordingMediaResult>;
  deleteRecording(recordingSid: string, context: ProviderContext): Promise<{ success: boolean; status: string }>;
}

export class TwilioRecordingAdapter implements RecordingProviderAdapter {
  private getAccountSid(context: ProviderContext): string | undefined {
    if (context.accountReference && context.accountReference.startsWith('AC')) {
      return context.accountReference;
    }
    if (context.isSharedParent || context.accountType === 'SHARED_PARENT') {
      return process.env.TWILIO_ACCOUNT_SID;
    }
    // CUSTOMER_SUBACCOUNT without valid AC SID fails closed immediately
    return undefined;
  }

  getRecordingStreamUrl(recordingSid: string, context: ProviderContext): string {
    const accountSid = this.getAccountSid(context);
    return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}.mp3`;
  }

  async fetchRecordingMedia(recordingSid: string, context: ProviderContext): Promise<RecordingMediaResult> {
    const accountSid = this.getAccountSid(context);
    const authToken = await ProviderClientFactory.resolveAccountAuthTokenAsync(context.accountReference);

    if (!accountSid || !authToken) {
      return {
        ok: false,
        status: 500,
        errorMessage: 'Twilio server credentials unconfigured.',
      };
    }

    const url = this.getRecordingStreamUrl(recordingSid, context);
    const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    try {
      const res = await fetch(url, {
        headers: {
          Authorization: authHeader,
        },
      });

      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          errorMessage: `Failed to fetch recording media: HTTP ${res.status}`,
        };
      }

      const buffer = await res.arrayBuffer();
      return {
        ok: true,
        status: 200,
        data: buffer,
        contentType: res.headers.get('content-type') || 'audio/mpeg',
      };
    } catch (err: any) {
      return {
        ok: false,
        status: 500,
        errorMessage: err?.message || 'Network error fetching recording media',
      };
    }
  }

  async deleteRecording(recordingSid: string, context: ProviderContext): Promise<{ success: boolean; status: string }> {
    const accountSid = this.getAccountSid(context);
    const authToken = await ProviderClientFactory.resolveAccountAuthTokenAsync(context.accountReference);

    if (!accountSid || !authToken) {
      throw new Error('Twilio credentials missing for provider deletion mutation.');
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}.json`;
    const authHeader = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;

    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: authHeader,
      },
    });

    if (res.status === 204 || res.status === 200) {
      return { success: true, status: 'provider_deleted' };
    }
    if (res.status === 404) {
      return { success: true, status: 'already_deleted' };
    }

    return { success: false, status: `failed_http_${res.status}` };
  }
}
