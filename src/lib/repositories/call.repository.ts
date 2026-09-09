import { createClient } from '../supabase/client';
import { Call, CallInsert } from '../types';

export class CallRepository {
  private supabase = createClient();

  async getCalls(organizationId: string, limit = 50): Promise<Call[]> {
    const { data, error } = await this.supabase
      .from('calls')
      .select('*')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error fetching call logs:', error);
      return [];
    }
    return (data as Call[]) || [];
  }

  async getMissedCalls(organizationId: string): Promise<Call[]> {
    const { data, error } = await this.supabase
      .from('calls')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('status', 'missed')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching missed calls:', error);
      return [];
    }
    return (data as Call[]) || [];
  }

  async logCall(callData: CallInsert): Promise<Call | null> {
    const { data, error } = await this.supabase
      .from('calls')
      .insert([callData] as any)
      .select()
      .single();

    if (error) {
      console.error('Error logging call:', error);
      return null;
    }
    return data as Call;
  }
}
