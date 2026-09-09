import { createClient } from '../supabase/client';
import { Recording } from '../types';

export class RecordingRepository {
  private supabase = createClient();

  async getRecordings(organizationId: string): Promise<Recording[]> {
    const { data, error } = await this.supabase
      .from('recordings')
      .select('*')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching recording metadata:', error);
      return [];
    }
    return (data as Recording[]) || [];
  }
}
