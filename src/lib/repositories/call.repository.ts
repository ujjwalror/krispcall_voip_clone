import { createClient } from '../supabase/client';
import { Call, CallInsert } from '../types';

export interface CallWithProfile extends Call {
  profiles?: {
    full_name: string;
    email: string;
    avatar_url?: string | null;
  } | null;
}

export class CallRepository {
  private supabase = createClient();

  async getCalls(organizationId?: string, limit = 50): Promise<CallWithProfile[]> {
    let query = this.supabase
      .from('calls')
      .select('*, profiles:user_id(full_name, email, avatar_url)')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching call logs:', error);
      return [];
    }
    return (data as any[]) || [];
  }

  async getMissedInboundCalls(organizationId?: string, limit = 50): Promise<CallWithProfile[]> {
    let query = this.supabase
      .from('calls')
      .select('*, profiles:user_id(full_name, email, avatar_url)')
      .eq('direction', 'inbound')
      .in('status', ['missed', 'no-answer', 'busy', 'canceled'])
      .order('created_at', { ascending: false })
      .limit(limit);

    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching missed inbound calls:', error);
      return [];
    }
    return (data as any[]) || [];
  }

  async getFilteredCalls(options: {
    organizationId?: string;
    direction?: 'all' | 'inbound' | 'outbound';
    status?: 'all' | 'completed' | 'missed' | 'failed' | 'no-answer';
    search?: string;
    limit?: number;
  }): Promise<CallWithProfile[]> {
    let query = this.supabase
      .from('calls')
      .select('*, profiles:user_id(full_name, email, avatar_url)')
      .order('created_at', { ascending: false })
      .limit(options.limit || 100);

    if (options.organizationId) {
      query = query.eq('organization_id', options.organizationId);
    }

    if (options.direction && options.direction !== 'all') {
      query = query.eq('direction', options.direction);
    }

    if (options.status && options.status !== 'all') {
      if (options.status === 'completed') {
        query = query.in('status', ['completed', 'answered', 'in-progress']);
      } else if (options.status === 'missed') {
        query = query.in('status', ['no-answer', 'busy', 'canceled', 'missed']);
      } else if (options.status === 'failed') {
        query = query.eq('status', options.status);
      } else {
        query = query.eq('status', options.status);
      }
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching filtered calls:', error);
      return [];
    }

    let results = (data as any[]) || [];

    if (options.search && options.search.trim() !== '') {
      const q = options.search.toLowerCase().trim();
      results = results.filter((call) => {
        const from = (call.from_number || '').toLowerCase();
        const to = (call.to_number || '').toLowerCase();
        const name = (call.profiles?.full_name || '').toLowerCase();
        return from.includes(q) || to.includes(q) || name.includes(q);
      });
    }

    return results;
  }

  async getTodayCallsCount(): Promise<number> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { count, error } = await this.supabase
      .from('calls')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', todayStart.toISOString());

    if (error) {
      console.error('Error fetching today calls count:', error);
      return 0;
    }
    return count || 0;
  }

  async getTotalCallsCount(organizationId?: string): Promise<number> {
    let query = this.supabase.from('calls').select('*', { count: 'exact', head: true });
    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }
    const { count, error } = await query;
    if (error) {
      console.error('Error fetching total calls count:', error);
      return 0;
    }
    return count || 0;
  }

  async getMissedCallsCount(): Promise<number> {
    const { count, error } = await this.supabase
      .from('calls')
      .select('*', { count: 'exact', head: true })
      .in('status', ['no-answer', 'busy', 'failed', 'canceled', 'missed']);

    if (error) {
      console.error('Error fetching missed calls count:', error);
      return 0;
    }
    return count || 0;
  }

  async getMissedInboundCallsCount(organizationId?: string): Promise<number> {
    let query = this.supabase
      .from('calls')
      .select('*', { count: 'exact', head: true })
      .eq('direction', 'inbound')
      .in('status', ['missed', 'no-answer', 'busy', 'canceled']);

    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }

    const { count, error } = await query;
    if (error) {
      console.error('Error fetching missed inbound calls count:', error);
      return 0;
    }
    return count || 0;
  }

  async getActiveAgentsCount(organizationId?: string): Promise<number> {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    let query = this.supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .eq('active', true)
      .eq('availability_status', 'available')
      .gte('last_seen_at', twoMinutesAgo);

    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }

    const { count, error } = await query;
    if (error) {
      console.error('Error fetching active agents count:', error);
      return 0;
    }
    return count || 0;
  }

  async getMessagesCount(organizationId?: string): Promise<number> {
    let query = this.supabase.from('messages').select('*', { count: 'exact', head: true });
    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }
    const { count, error } = await query;
    if (error) {
      console.error('Error fetching messages count:', error);
      return 0;
    }
    return count || 0;
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
