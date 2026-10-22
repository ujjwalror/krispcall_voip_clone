import 'server-only';
import { ProviderContext } from '../types';
import { ProviderClientFactory } from '../providerClientFactory';

export interface SearchAvailableNumbersParams {
  countryCode: string;
  type?: 'local' | 'mobile' | 'toll_free';
  areaCode?: string;
  limit?: number;
}

export interface PurchaseNumberParams {
  phoneNumber: string;
  friendlyName?: string;
}

export interface AvailableNumberResult {
  phoneNumber: string;
  friendlyName: string;
  isoCountry: string;
  capabilities: {
    voice: boolean;
    sms: boolean;
    mms: boolean;
  };
}

export interface NumberProviderAdapter {
  searchAvailableNumbers(params: SearchAvailableNumbersParams, context: ProviderContext): Promise<AvailableNumberResult[]>;
  purchaseNumber(params: PurchaseNumberParams, context: ProviderContext): Promise<{ phoneNumberSid: string; phoneNumber: string }>;
  releaseNumber(providerResourceId: string, context: ProviderContext): Promise<{ success: boolean }>;
  fetchCapabilities(providerResourceId: string, context: ProviderContext): Promise<{ voice: boolean; sms: boolean; mms: boolean }>;
}

export class TwilioNumberAdapter implements NumberProviderAdapter {
  async searchAvailableNumbers(params: SearchAvailableNumbersParams, context: ProviderContext): Promise<AvailableNumberResult[]> {
    const client = await ProviderClientFactory.getTwilioClientAsync(context);
    const country = params.countryCode.toUpperCase();
    const type = params.type || 'local';

    let results: any[] = [];
    if (type === 'mobile' && client.availablePhoneNumbers(country).mobile) {
      results = await client.availablePhoneNumbers(country).mobile.list({ limit: params.limit || 10 });
    } else if (type === 'toll_free' && client.availablePhoneNumbers(country).tollFree) {
      results = await client.availablePhoneNumbers(country).tollFree.list({ limit: params.limit || 10 });
    } else {
      results = await client.availablePhoneNumbers(country).local.list({
        areaCode: params.areaCode ? parseInt(params.areaCode, 10) : undefined,
        limit: params.limit || 10,
      });
    }

    return results.map((r: any) => ({
      phoneNumber: r.phoneNumber,
      friendlyName: r.friendlyName,
      isoCountry: r.isoCountry,
      capabilities: {
        voice: Boolean(r.capabilities?.voice),
        sms: Boolean(r.capabilities?.sms),
        mms: Boolean(r.capabilities?.mms),
      },
    }));
  }

  async purchaseNumber(params: PurchaseNumberParams, context: ProviderContext): Promise<{ phoneNumberSid: string; phoneNumber: string }> {
    if (params.phoneNumber === '+61348328472') {
      throw new Error('PROTECTED_PILOT_QUARANTINE_VIOLATION: Number purchase refused for protected pilot number.');
    }
    const enabled = process.env.TWILIO_COMMERCE_MUTATIONS_ENABLED === 'true';
    if (!enabled) {
      throw new Error('PROVIDER_MUTATIONS_DISABLED: Live number purchases are disabled in this environment.');
    }

    const client = await ProviderClientFactory.getTwilioClientAsync(context);
    const purchased = await client.incomingPhoneNumbers.create({
      phoneNumber: params.phoneNumber,
      friendlyName: params.friendlyName || params.phoneNumber,
    });

    return {
      phoneNumberSid: purchased.sid,
      phoneNumber: purchased.phoneNumber,
    };
  }

  async releaseNumber(providerResourceId: string, context: ProviderContext): Promise<{ success: boolean }> {
    if (
      providerResourceId === 'PN832a10dec98cbb48d02033a83afecff3' ||
      context.organizationId === '00000000-0000-0000-0000-000000000001'
    ) {
      throw new Error('PROTECTED_PILOT_QUARANTINE_VIOLATION: Number release refused for protected pilot PN SID.');
    }
    if (context.accountType === 'SHARED_PARENT' || context.isSharedParent === true) {
      throw new Error('PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED: Cannot release customer phone number under shared parent account.');
    }
    const enabled = process.env.TWILIO_COMMERCE_MUTATIONS_ENABLED === 'true';
    if (!enabled) {
      throw new Error('PROVIDER_MUTATIONS_DISABLED: Live number releases are disabled in this environment.');
    }

    const client = await ProviderClientFactory.getTwilioClientAsync(context);
    await client.incomingPhoneNumbers(providerResourceId).remove();
    return { success: true };
  }

  async fetchCapabilities(providerResourceId: string, context: ProviderContext): Promise<{ voice: boolean; sms: boolean; mms: boolean }> {
    const client = await ProviderClientFactory.getTwilioClientAsync(context);
    const num = await client.incomingPhoneNumbers(providerResourceId).fetch();
    return {
      voice: Boolean(num.capabilities?.voice),
      sms: Boolean(num.capabilities?.sms),
      mms: Boolean(num.capabilities?.mms),
    };
  }
}
