import { createClient } from '../supabase/client';
import { PhoneNumber } from '../types';

export class PhoneRepository {
  private supabase = createClient();

  async getPhoneNumbers(organizationId: string): Promise<PhoneNumber[]> {
    const { data, error } = await this.supabase
      .from('phone_numbers')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('active', true);

    if (error) {
      console.error('Error fetching phone numbers:', error);
      return [];
    }
    return (data as PhoneNumber[]) || [];
  }
}
