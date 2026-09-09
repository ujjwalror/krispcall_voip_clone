export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type UserRole = 'admin' | 'agent';
export type CallDirection = 'inbound' | 'outbound';
export type CallStatus =
  | 'queued'
  | 'initiated'
  | 'ringing'
  | 'in-progress'
  | 'completed'
  | 'busy'
  | 'failed'
  | 'no-answer'
  | 'canceled'
  | 'missed';
export type MessageDirection = 'inbound' | 'outbound';

export interface Database {
  public: {
    Tables: {
      organizations: {
        Row: {
          id: string;
          name: string;
          slug: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          slug?: string;
          created_at?: string;
          updated_at?: string;
        };
      };
      profiles: {
        Row: {
          id: string;
          organization_id: string;
          full_name: string;
          email: string;
          role: UserRole;
          active: boolean;
          twilio_identity: string | null;
          avatar_url: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          organization_id: string;
          full_name: string;
          email: string;
          role?: UserRole;
          active?: boolean;
          twilio_identity?: string | null;
          avatar_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          full_name?: string;
          email?: string;
          role?: UserRole;
          active?: boolean;
          twilio_identity?: string | null;
          avatar_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      contacts: {
        Row: {
          id: string;
          organization_id: string;
          first_name: string | null;
          last_name: string | null;
          full_name: string;
          company: string | null;
          phone: string;
          email: string | null;
          notes: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          archived_at: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          first_name?: string | null;
          last_name?: string | null;
          full_name: string;
          company?: string | null;
          phone: string;
          email?: string | null;
          notes?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          archived_at?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          first_name?: string | null;
          last_name?: string | null;
          full_name?: string;
          company?: string | null;
          phone?: string;
          email?: string | null;
          notes?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          archived_at?: string | null;
        };
      };
      calls: {
        Row: {
          id: string;
          organization_id: string;
          twilio_call_sid: string | null;
          user_id: string | null;
          contact_id: string | null;
          direction: CallDirection;
          from_number: string;
          to_number: string;
          status: CallStatus;
          started_at: string | null;
          answered_at: string | null;
          ended_at: string | null;
          duration_seconds: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          twilio_call_sid?: string | null;
          user_id?: string | null;
          contact_id?: string | null;
          direction: CallDirection;
          from_number: string;
          to_number: string;
          status?: CallStatus;
          started_at?: string | null;
          answered_at?: string | null;
          ended_at?: string | null;
          duration_seconds?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          twilio_call_sid?: string | null;
          user_id?: string | null;
          contact_id?: string | null;
          direction?: CallDirection;
          from_number?: string;
          to_number?: string;
          status?: CallStatus;
          started_at?: string | null;
          answered_at?: string | null;
          ended_at?: string | null;
          duration_seconds?: number;
          created_at?: string;
          updated_at?: string;
        };
      };
      recordings: {
        Row: {
          id: string;
          organization_id: string;
          call_id: string | null;
          twilio_recording_sid: string | null;
          recording_url: string;
          duration_seconds: number;
          status: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          call_id?: string | null;
          twilio_recording_sid?: string | null;
          recording_url: string;
          duration_seconds?: number;
          status?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          call_id?: string | null;
          twilio_recording_sid?: string | null;
          recording_url?: string;
          duration_seconds?: number;
          status?: string;
          created_at?: string;
          updated_at?: string;
        };
      };
      messages: {
        Row: {
          id: string;
          organization_id: string;
          twilio_message_sid: string | null;
          user_id: string | null;
          contact_id: string | null;
          from_number: string;
          to_number: string;
          body: string;
          direction: MessageDirection;
          status: string;
          sent_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          twilio_message_sid?: string | null;
          user_id?: string | null;
          contact_id?: string | null;
          from_number: string;
          to_number: string;
          body: string;
          direction: MessageDirection;
          status?: string;
          sent_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          twilio_message_sid?: string | null;
          user_id?: string | null;
          contact_id?: string | null;
          from_number?: string;
          to_number?: string;
          body?: string;
          direction?: MessageDirection;
          status?: string;
          sent_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      phone_numbers: {
        Row: {
          id: string;
          organization_id: string;
          twilio_phone_number_sid: string | null;
          phone_number: string;
          friendly_name: string | null;
          active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          twilio_phone_number_sid?: string | null;
          phone_number: string;
          friendly_name?: string | null;
          active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          twilio_phone_number_sid?: string | null;
          phone_number?: string;
          friendly_name?: string | null;
          active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
      };
      user_phone_assignments: {
        Row: {
          id: string;
          organization_id: string;
          user_id: string;
          phone_number_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          user_id: string;
          phone_number_id: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          user_id?: string;
          phone_number_id?: string;
          created_at?: string;
        };
      };
    };
  };
}
