import { createClient } from '../supabase/client';
import { Contact, ContactInsert } from '../types';

export class ContactRepository {
  private supabase = createClient();

  async getContacts(organizationId: string): Promise<Contact[]> {
    const { data, error } = await this.supabase
      .from('contacts')
      .select('*')
      .eq('organization_id', organizationId)
      .is('archived_at', null)
      .order('full_name', { ascending: true });

    if (error) {
      console.error('Error fetching contacts:', error);
      return [];
    }
    return (data as Contact[]) || [];
  }

  async searchContacts(organizationId: string, query: string): Promise<Contact[]> {
    const { data, error } = await this.supabase
      .from('contacts')
      .select('*')
      .eq('organization_id', organizationId)
      .or(`full_name.ilike.%${query}%,phone.ilike.%${query}%,company.ilike.%${query}%`)
      .is('archived_at', null);

    if (error) {
      console.error('Error searching contacts:', error);
      return [];
    }
    return (data as Contact[]) || [];
  }

  async createContact(contact: ContactInsert): Promise<Contact | null> {
    const { data, error } = await this.supabase
      .from('contacts')
      .insert([contact] as any)
      .select()
      .single();

    if (error) {
      console.error('Error creating contact:', error);
      return null;
    }
    return data as Contact;
  }
}
