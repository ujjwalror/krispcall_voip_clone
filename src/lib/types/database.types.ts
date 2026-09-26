export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type UserRole = 'owner' | 'admin' | 'manager' | 'agent';
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
export type MessageStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'undelivered'
  | 'failed'
  | 'received';

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
          status?: 'active' | 'suspended' | 'deactivated';
          routing_strategy?: string;
          prefer_assigned_agent?: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          status?: 'active' | 'suspended' | 'deactivated';
          routing_strategy?: string;
          prefer_assigned_agent?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          slug?: string;
          status?: 'active' | 'suspended' | 'deactivated';
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
          error_code: string | null;
          error_message: string | null;
          is_read: boolean;
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
          error_code?: string | null;
          error_message?: string | null;
          is_read?: boolean;
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
          error_code?: string | null;
          error_message?: string | null;
          is_read?: boolean;
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
          capabilities_voice: boolean;
          capabilities_sms: boolean;
          capabilities_mms: boolean;
          status: 'active' | 'inactive' | 'suspended' | 'released' | 'ported_out';
          country_code: string | null;
          number_type: 'local' | 'mobile' | 'toll_free' | null;
          acquisition_source: 'provider_purchase' | 'port_in' | 'legacy' | null;
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
          capabilities_voice?: boolean;
          capabilities_sms?: boolean;
          capabilities_mms?: boolean;
          status?: 'active' | 'inactive' | 'suspended' | 'released' | 'ported_out';
          country_code?: string | null;
          number_type?: 'local' | 'mobile' | 'toll_free' | null;
          acquisition_source?: 'provider_purchase' | 'port_in' | 'legacy' | null;
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
          capabilities_voice?: boolean;
          capabilities_sms?: boolean;
          capabilities_mms?: boolean;
          status?: 'active' | 'inactive' | 'suspended' | 'released' | 'ported_out';
          country_code?: string | null;
          number_type?: 'local' | 'mobile' | 'toll_free' | null;
          acquisition_source?: 'provider_purchase' | 'port_in' | 'legacy' | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      number_provider_mappings: {
        Row: {
          id: string;
          phone_number_id: string;
          provider: string;
          provider_account_id: string | null;
          provider_resource_id: string;
          provider_status: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          phone_number_id: string;
          provider?: string;
          provider_account_id?: string | null;
          provider_resource_id: string;
          provider_status?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          phone_number_id?: string;
          provider?: string;
          provider_account_id?: string | null;
          provider_resource_id?: string;
          provider_status?: string | null;
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
      plans: {
        Row: {
          id: string;
          code: string;
          name: string;
          description: string | null;
          is_active: boolean;
          is_public: boolean;
          trial_days_default: number | null;
          sort_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          code: string;
          name: string;
          description?: string | null;
          is_active?: boolean;
          is_public?: boolean;
          trial_days_default?: number | null;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          code?: string;
          name?: string;
          description?: string | null;
          is_active?: boolean;
          is_public?: boolean;
          trial_days_default?: number | null;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
      };
      features: {
        Row: {
          id: string;
          code: string;
          name: string;
          value_type: 'boolean' | 'numeric' | 'text';
          description: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          code: string;
          name: string;
          value_type: 'boolean' | 'numeric' | 'text';
          description?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          code?: string;
          name?: string;
          value_type?: 'boolean' | 'numeric' | 'text';
          description?: string | null;
          created_at?: string;
        };
      };
      plan_entitlements: {
        Row: {
          id: string;
          plan_id: string;
          feature_code: string;
          enabled: boolean;
          numeric_value: number | null;
          text_value: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          plan_id: string;
          feature_code: string;
          enabled?: boolean;
          numeric_value?: number | null;
          text_value?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          plan_id?: string;
          feature_code?: string;
          enabled?: boolean;
          numeric_value?: number | null;
          text_value?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      organization_subscriptions: {
        Row: {
          id: string;
          organization_id: string;
          plan_id: string;
          price_id: string | null;
          status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'expired' | 'suspended';
          current_period_start: string | null;
          current_period_end: string | null;
          trial_ends_at: string | null;
          cancel_at_period_end: boolean;
          canceled_at: string | null;
          ended_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          plan_id: string;
          price_id?: string | null;
          status?: 'trialing' | 'active' | 'past_due' | 'canceled' | 'expired' | 'suspended';
          current_period_start?: string | null;
          current_period_end?: string | null;
          trial_ends_at?: string | null;
          cancel_at_period_end?: boolean;
          canceled_at?: string | null;
          ended_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          plan_id?: string;
          price_id?: string | null;
          status?: 'trialing' | 'active' | 'past_due' | 'canceled' | 'expired' | 'suspended';
          current_period_start?: string | null;
          current_period_end?: string | null;
          trial_ends_at?: string | null;
          cancel_at_period_end?: boolean;
          canceled_at?: string | null;
          ended_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      prices: {
        Row: {
          id: string;
          plan_id: string;
          currency: string;
          billing_interval: 'monthly' | 'annual';
          pricing_model: 'per_seat' | 'base_plus_seat' | 'flat' | 'custom';
          unit_amount_minor: number | null;
          base_amount_minor: number | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          plan_id: string;
          currency: string;
          billing_interval: 'monthly' | 'annual';
          pricing_model: 'per_seat' | 'base_plus_seat' | 'flat' | 'custom';
          unit_amount_minor?: number | null;
          base_amount_minor?: number | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          plan_id?: string;
          currency?: string;
          billing_interval?: 'monthly' | 'annual';
          pricing_model?: 'per_seat' | 'base_plus_seat' | 'flat' | 'custom';
          unit_amount_minor?: number | null;
          base_amount_minor?: number | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
      };
      billing_outbox_events: {
        Row: {
          id: string;
          organization_id: string;
          event_type: string;
          payload: Record<string, any>;
          status: 'pending' | 'processing' | 'completed' | 'failed';
          attempt_count: number;
          available_at: string;
          processed_at: string | null;
          last_error: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          event_type: string;
          payload?: Record<string, any>;
          status?: 'pending' | 'processing' | 'completed' | 'failed';
          attempt_count?: number;
          available_at?: string;
          processed_at?: string | null;
          last_error?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          event_type?: string;
          payload?: Record<string, any>;
          status?: 'pending' | 'processing' | 'completed' | 'failed';
          attempt_count?: number;
          available_at?: string;
          processed_at?: string | null;
          last_error?: string | null;
          created_at?: string;
        };
      };
      organization_entitlement_overrides: {
        Row: {
          id: string;
          organization_id: string;
          feature_code: string;
          enabled: boolean;
          numeric_value: number | null;
          text_value: string | null;
          expires_at: string | null;
          reason: string | null;
          created_by_user_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          feature_code: string;
          enabled?: boolean;
          numeric_value?: number | null;
          text_value?: string | null;
          expires_at?: string | null;
          reason?: string | null;
          created_by_user_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          feature_code?: string;
          enabled?: boolean;
          numeric_value?: number | null;
          text_value?: string | null;
          expires_at?: string | null;
          reason?: string | null;
          created_by_user_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      billing_provider_customers: {
        Row: {
          id: string;
          organization_id: string;
          provider: string;
          provider_customer_id: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          provider: string;
          provider_customer_id: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          provider?: string;
          provider_customer_id?: string;
          created_at?: string;
          updated_at?: string;
        };
      };
      billing_provider_prices: {
        Row: {
          id: string;
          price_id: string;
          provider: string;
          provider_price_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          price_id: string;
          provider: string;
          provider_price_id: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          price_id?: string;
          provider?: string;
          provider_price_id?: string;
          created_at?: string;
        };
      };
      billing_provider_subscriptions: {
        Row: {
          id: string;
          organization_subscription_id: string;
          provider: string;
          provider_subscription_id: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_subscription_id: string;
          provider: string;
          provider_subscription_id: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_subscription_id?: string;
          provider?: string;
          provider_subscription_id?: string;
          created_at?: string;
          updated_at?: string;
        };
      };
      billing_webhook_events: {
        Row: {
          id: string;
          provider: string;
          provider_event_id: string;
          event_type: string;
          payload: Record<string, any>;
          status: 'pending' | 'processing' | 'completed' | 'failed';
          attempt_count: number;
          available_at: string;
          processing_started_at: string | null;
          processed_at: string | null;
          last_error: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          provider: string;
          provider_event_id: string;
          event_type: string;
          payload: Record<string, any>;
          status?: 'pending' | 'processing' | 'completed' | 'failed';
          attempt_count?: number;
          available_at?: string;
          processing_started_at?: string | null;
          processed_at?: string | null;
          last_error?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          provider?: string;
          provider_event_id?: string;
          event_type?: string;
          payload?: Record<string, any>;
          status?: 'pending' | 'processing' | 'completed' | 'failed';
          attempt_count?: number;
          available_at?: string;
          processing_started_at?: string | null;
          processed_at?: string | null;
          last_error?: string | null;
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
