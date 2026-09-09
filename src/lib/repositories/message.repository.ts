import { createClient } from '../supabase/client';
import { Message, MessageInsert } from '../types';

export class MessageRepository {
  private supabase = createClient();

  async getMessages(organizationId: string, limit = 50): Promise<Message[]> {
    const { data, error } = await this.supabase
      .from('messages')
      .select('*')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error fetching messages:', error);
      return [];
    }
    return (data as Message[]) || [];
  }

  async saveMessage(messageData: MessageInsert): Promise<Message | null> {
    const { data, error } = await this.supabase
      .from('messages')
      .insert([messageData] as any)
      .select()
      .single();

    if (error) {
      console.error('Error saving message:', error);
      return null;
    }
    return data as Message;
  }
}
