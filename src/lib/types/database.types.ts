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
  | 'missed'
  | 'blocked';
export type MessageDirection = 'inbound' | 'outbound';

export interface Database {
  public: {
    Tables: {
      caller_assignments: {
        Row: {
          id: string;
          organization_id: string;
          phone_number: string;
          assigned_user_id: string | null;
          assignment_source: 'auto_answered' | 'manual';
          assigned_by_user_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          phone_number: string;
          assigned_user_id?: string | null;
          assignment_source?: 'auto_answered' | 'manual';
          assigned_by_user_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          phone_number?: string;
          assigned_user_id?: string | null;
          assignment_source?: 'auto_answered' | 'manual';
          assigned_by_user_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      organizations: {
        Row: {
          id: string;
          name: string;
          slug: string;
          routing_strategy?: string;
          prefer_assigned_agent?: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          routing_strategy?: string;
          prefer_assigned_agent?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          slug?: string;
          routing_strategy?: string;
          prefer_assigned_agent?: boolean;
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
          timezone: string | null;
          time_format: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          full_name: string;
          email: string;
          role?: UserRole;
          active?: boolean;
          twilio_identity?: string | null;
          avatar_url?: string | null;
          timezone?: string | null;
          time_format?: string;
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
          timezone?: string | null;
          time_format?: string;
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
          is_blocked: boolean | null;
          created_by: string | null;
          assigned_user_id?: string | null;
          assigned_user?: {
            id: string;
            full_name: string;
            email: string;
            role: string;
            avatar_url?: string | null;
          } | null;
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
          is_blocked?: boolean | null;
          created_by?: string | null;
          assigned_user_id?: string | null;
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
          is_blocked?: boolean | null;
          created_by?: string | null;
          assigned_user_id?: string | null;
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
          is_primary: boolean;
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
          is_primary?: boolean;
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
          is_primary?: boolean;
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
      blocked_numbers: {
        Row: {
          id: string;
          organization_id: string;
          phone_number: string;
          normalized_phone: string;
          contact_id: string | null;
          reason: string | null;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          phone_number: string;
          normalized_phone: string;
          contact_id?: string | null;
          reason?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          phone_number?: string;
          normalized_phone?: string;
          contact_id?: string | null;
          reason?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
      };
    };
    Functions: {
      convert_lead_to_contact: {
        Args: {
          p_organization_id: string;
          p_first_name?: string | null;
          p_last_name?: string | null;
          p_full_name: string;
          p_phone: string;
          p_email?: string | null;
          p_company?: string | null;
          p_notes?: string | null;
          p_is_blocked?: boolean;
          p_created_by?: string | null;
          p_explicit_assigned_user_id?: string | null;
        };
        Returns: Database['public']['Tables']['contacts']['Row'][];
      };
      try_auto_assign_caller: {
        Args: {
          p_organization_id: string;
          p_phone: string;
          p_assigned_user_id: string;
        };
        Returns: boolean;
      };
      manually_assign_caller: {
        Args: {
          p_organization_id: string;
          p_phone: string;
          p_assigned_user_id?: string | null;
          p_assigned_by_user_id: string;
        };
        Returns: {
          is_contact: boolean;
          contact_id: string | null;
          assigned_user_id: string | null;
        }[];
      };
    };
  };
}
