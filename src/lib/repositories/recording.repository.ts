import { createClient } from '../supabase/client';
import { Recording } from '../types';

export interface RecordingWithDetails extends Recording {
  calls?: {
    to_number: string;
    from_number: string;
    direction: string;
    created_at: string;
    user_id?: string;
    profiles?: {
      full_name: string;
      email: string;
    } | null;
  } | null;
}

export class RecordingRepository {
  private supabase = createClient();

  async getRecordings(organizationId?: string): Promise<RecordingWithDetails[]> {
    let query = this.supabase
      .from('recordings')
      .select('*, calls:call_id(to_number, from_number, direction, created_at, user_id, profiles:user_id(full_name, email))')
      .order('created_at', { ascending: false });

    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching recording metadata:', error);
      return [];
    }
    return (data as any[]) || [];
  }
}
