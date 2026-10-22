import 'server-only';
import { ProviderContext } from '../types';
import { ProviderClientFactory } from '../providerClientFactory';

export interface SendSmsParams {
  from: string;
  to: string;
  body: string;
  statusCallback?: string;
}

export interface SendMmsParams {
  from: string;
  to: string;
  body?: string;
  mediaUrls: string[];
  statusCallback?: string;
}

export interface MessagingProviderAdapter {
  sendSms(params: SendSmsParams, context: ProviderContext): Promise<{ messageSid: string; status: string }>;
  sendMms(params: SendMmsParams, context: ProviderContext): Promise<{ messageSid: string; status: string }>;
  fetchMessage(messageSid: string, context: ProviderContext): Promise<{ messageSid: string; status: string }>;
}

export class TwilioMessagingAdapter implements MessagingProviderAdapter {
  async sendSms(params: SendSmsParams, context: ProviderContext): Promise<{ messageSid: string; status: string }> {
    const client = await ProviderClientFactory.getTwilioClientAsync(context);
    const msg = await client.messages.create({
      from: params.from,
      to: params.to,
      body: params.body,
      statusCallback: params.statusCallback,
    });
    return {
      messageSid: msg.sid,
      status: msg.status,
    };
  }

  async sendMms(params: SendMmsParams, context: ProviderContext): Promise<{ messageSid: string; status: string }> {
    const client = await ProviderClientFactory.getTwilioClientAsync(context);
    const msg = await client.messages.create({
      from: params.from,
      to: params.to,
      body: params.body || '',
      mediaUrl: params.mediaUrls,
      statusCallback: params.statusCallback,
    });
    return {
      messageSid: msg.sid,
      status: msg.status,
    };
  }

  async fetchMessage(messageSid: string, context: ProviderContext): Promise<{ messageSid: string; status: string }> {
    const client = await ProviderClientFactory.getTwilioClientAsync(context);
    const msg = await client.messages(messageSid).fetch();
    return {
      messageSid: msg.sid,
      status: msg.status,
    };
  }
}
