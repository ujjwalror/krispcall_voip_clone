import 'server-only';
import { ProviderContext } from '../types';
import { ProviderClientFactory } from '../providerClientFactory';

export interface InitiateCallParams {
  from: string;
  to: string;
  url?: string;
  timeLimit?: number;
  statusCallback?: string;
  record?: boolean;
}

export interface ModifyCallParams {
  callSid: string;
  status?: 'completed' | 'canceled';
  url?: string;
  method?: 'POST' | 'GET';
}

export interface VoiceProviderAdapter {
  initiateCall(params: InitiateCallParams, context: ProviderContext): Promise<{ callSid: string }>;
  terminateCall(callSid: string, context: ProviderContext): Promise<{ success: boolean }>;
  modifyCall(params: ModifyCallParams, context: ProviderContext): Promise<{ success: boolean }>;
  fetchCall(callSid: string, context: ProviderContext): Promise<{ callSid: string; status: string; duration?: number }>;
}

export class TwilioVoiceAdapter implements VoiceProviderAdapter {
  async initiateCall(params: InitiateCallParams, context: ProviderContext): Promise<{ callSid: string }> {
    const client = await ProviderClientFactory.getTwilioClientAsync(context);
    const call = await client.calls.create({
      from: params.from,
      to: params.to,
      url: params.url || '',
      timeLimit: params.timeLimit,
      statusCallback: params.statusCallback,
      record: params.record,
    });
    return { callSid: call.sid };
  }

  async terminateCall(callSid: string, context: ProviderContext): Promise<{ success: boolean }> {
    const client = await ProviderClientFactory.getTwilioClientAsync(context);
    await client.calls(callSid).update({ status: 'completed' });
    return { success: true };
  }

  async modifyCall(params: ModifyCallParams, context: ProviderContext): Promise<{ success: boolean }> {
    const client = await ProviderClientFactory.getTwilioClientAsync(context);
    const updatePayload: any = {};
    if (params.status) updatePayload.status = params.status;
    if (params.url) updatePayload.url = params.url;
    if (params.method) updatePayload.method = params.method;

    await client.calls(params.callSid).update(updatePayload);
    return { success: true };
  }

  async fetchCall(callSid: string, context: ProviderContext): Promise<{ callSid: string; status: string; duration?: number }> {
    const client = await ProviderClientFactory.getTwilioClientAsync(context);
    const call = await client.calls(callSid).fetch();
    return {
      callSid: call.sid,
      status: call.status,
      duration: call.duration ? parseInt(call.duration, 10) : undefined,
    };
  }
}
