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
          telecom_suspended: boolean;
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
          telecom_suspended?: boolean;
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
          telecom_suspended?: boolean;
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
          is_suspended: boolean;
          country_code: string | null;
          number_type: 'local' | 'mobile' | 'toll_free' | null;
          acquisition_source: 'provider_purchase' | 'port_in' | 'legacy' | null;
          ownership_state: 'ACQUISITION_PENDING' | 'OWNED' | 'RELEASE_PENDING' | 'RELEASED' | 'PORTED_OUT' | null;
          service_state: 'PROVISIONING' | 'ACTIVE' | 'SUSPENDED' | 'UNAVAILABLE' | null;
          provider_account_id: string | null;
          provider_resource_record_id: string | null;
          capabilities_state: Json;
          assignment_target_type: 'USER' | 'TEAM' | 'QUEUE' | 'IVR' | 'WORKSPACE_MAIN' | 'VOICEMAIL' | 'UNASSIGNED_POOL' | null;
          assignment_target_id: string | null;
          assigned_at: string | null;
          port_out_locked: boolean;
          port_out_lock_updated_at: string;
          port_out_lock_updated_by: string | null;
          released_at: string | null;
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
          is_suspended?: boolean;
          country_code?: string | null;
          number_type?: 'local' | 'mobile' | 'toll_free' | null;
          acquisition_source?: 'provider_purchase' | 'port_in' | 'legacy' | null;
          ownership_state?: 'ACQUISITION_PENDING' | 'OWNED' | 'RELEASE_PENDING' | 'RELEASED' | 'PORTED_OUT' | null;
          service_state?: 'PROVISIONING' | 'ACTIVE' | 'SUSPENDED' | 'UNAVAILABLE' | null;
          provider_account_id?: string | null;
          provider_resource_record_id?: string | null;
          capabilities_state?: Json;
          assignment_target_type?: 'USER' | 'TEAM' | 'QUEUE' | 'IVR' | 'WORKSPACE_MAIN' | 'VOICEMAIL' | 'UNASSIGNED_POOL' | null;
          assignment_target_id?: string | null;
          assigned_at?: string | null;
          port_out_locked?: boolean;
          port_out_lock_updated_at?: string;
          port_out_lock_updated_by?: string | null;
          released_at?: string | null;
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
          is_suspended?: boolean;
          country_code?: string | null;
          number_type?: 'local' | 'mobile' | 'toll_free' | null;
          acquisition_source?: 'provider_purchase' | 'port_in' | 'legacy' | null;
          ownership_state?: 'ACQUISITION_PENDING' | 'OWNED' | 'RELEASE_PENDING' | 'RELEASED' | 'PORTED_OUT' | null;
          service_state?: 'PROVISIONING' | 'ACTIVE' | 'SUSPENDED' | 'UNAVAILABLE' | null;
          provider_account_id?: string | null;
          provider_resource_record_id?: string | null;
          capabilities_state?: Json;
          assignment_target_type?: 'USER' | 'TEAM' | 'QUEUE' | 'IVR' | 'WORKSPACE_MAIN' | 'VOICEMAIL' | 'UNASSIGNED_POOL' | null;
          assignment_target_id?: string | null;
          assigned_at?: string | null;
          port_out_locked?: boolean;
          port_out_lock_updated_at?: string;
          port_out_lock_updated_by?: string | null;
          released_at?: string | null;
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
          payload: Json;
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
          payload?: Json;
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
          payload?: Json;
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
          payload: Json;
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
          payload: Json;
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
          payload?: Json;
          status?: 'pending' | 'processing' | 'completed' | 'failed';
          attempt_count?: number;
          available_at?: string;
          processing_started_at?: string | null;
          processed_at?: string | null;
          last_error?: string | null;
          created_at?: string;
        };
      };
      organization_billing_controls: {
        Row: {
          id: string;
          organization_id: string;
          max_daily_purchase_spend_minor: number | null;
          max_purchase_velocity_per_hour: number | null;
          max_active_numbers_limit: number | null;
          disallow_high_cost_destinations: boolean;
          risk_score_threshold: number | null;
          is_billing_restricted: boolean;
          restriction_reason: string | null;
          max_concurrent_voice_calls: number | null;
          telecom_suspended: boolean;
          allowed_destination_countries: string[] | null;
          blocked_destination_countries: string[] | null;
          voice_risk_ceiling_seconds: Json | null;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          max_daily_purchase_spend_minor?: number | null;
          max_purchase_velocity_per_hour?: number | null;
          max_active_numbers_limit?: number | null;
          disallow_high_cost_destinations?: boolean;
          risk_score_threshold?: number | null;
          is_billing_restricted?: boolean;
          restriction_reason?: string | null;
          max_concurrent_voice_calls?: number | null;
          telecom_suspended?: boolean;
          allowed_destination_countries?: string[] | null;
          blocked_destination_countries?: string[] | null;
          voice_risk_ceiling_seconds?: Json | null;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          max_daily_purchase_spend_minor?: number | null;
          max_purchase_velocity_per_hour?: number | null;
          max_active_numbers_limit?: number | null;
          disallow_high_cost_destinations?: boolean;
          risk_score_threshold?: number | null;
          is_billing_restricted?: boolean;
          restriction_reason?: string | null;
          max_concurrent_voice_calls?: number | null;
          telecom_suspended?: boolean;
          allowed_destination_countries?: string[] | null;
          blocked_destination_countries?: string[] | null;
          voice_risk_ceiling_seconds?: Json | null;
          updated_at?: string;
        };
      };
      telecom_messaging_consents: {
        Row: {
          id: string;
          organization_id: string;
          phone_number: string;
          status: 'opted_out' | 'opted_in' | 'unspecified';
          opt_out_keyword: string | null;
          opted_out_at: string | null;
          opted_in_at: string | null;
          metadata: Json | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          phone_number: string;
          status?: 'opted_out' | 'opted_in' | 'unspecified';
          opt_out_keyword?: string | null;
          opted_out_at?: string | null;
          opted_in_at?: string | null;
          metadata?: Json | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          phone_number?: string;
          status?: 'opted_out' | 'opted_in' | 'unspecified';
          opt_out_keyword?: string | null;
          opted_out_at?: string | null;
          opted_in_at?: string | null;
          metadata?: Json | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      telecom_security_events: {
        Row: {
          id: string;
          organization_id: string;
          user_id: string | null;
          phone_number: string | null;
          destination: string | null;
          risk_rule: string;
          operation: 'voice_dial' | 'call_transfer' | 'call_hold' | 'sms_send' | 'mms_send' | 'recording_access' | 'provider_mutation';
          decision: 'blocked' | 'restricted' | 'throttled' | 'allowed';
          reason: string;
          metadata: Json | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          user_id?: string | null;
          phone_number?: string | null;
          destination?: string | null;
          risk_rule: string;
          operation: 'voice_dial' | 'call_transfer' | 'call_hold' | 'sms_send' | 'mms_send' | 'recording_access' | 'provider_mutation';
          decision: 'blocked' | 'restricted' | 'throttled' | 'allowed';
          reason: string;
          metadata?: Json | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          user_id?: string | null;
          phone_number?: string | null;
          destination?: string | null;
          risk_rule?: string;
          operation?: 'voice_dial' | 'call_transfer' | 'call_hold' | 'sms_send' | 'mms_send' | 'recording_access' | 'provider_mutation';
          decision?: 'blocked' | 'restricted' | 'throttled' | 'allowed';
          reason?: string;
          metadata?: Json | null;
          created_at?: string;
        };
      };
      telecom_provider_accounts: {
        Row: {
          id: string;
          provider: string;
          account_type: 'SHARED_PARENT' | 'CUSTOMER_SUBACCOUNT' | 'DEDICATED_ACCOUNT' | 'OTHER';
          account_reference: string;
          credential_reference: string;
          status: 'active' | 'suspended' | 'deprovisioned' | 'maintenance';
          capabilities: string[];
          environment: 'production' | 'development' | 'staging' | 'sandbox';
          parent_provider_account_id: string | null;
          metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          provider: string;
          account_type: 'SHARED_PARENT' | 'CUSTOMER_SUBACCOUNT' | 'DEDICATED_ACCOUNT' | 'OTHER';
          account_reference: string;
          credential_reference: string;
          status?: 'active' | 'suspended' | 'deprovisioned' | 'maintenance';
          capabilities?: string[];
          environment?: 'production' | 'development' | 'staging' | 'sandbox';
          parent_provider_account_id?: string | null;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          provider?: string;
          account_type?: 'SHARED_PARENT' | 'CUSTOMER_SUBACCOUNT' | 'DEDICATED_ACCOUNT' | 'OTHER';
          account_reference?: string;
          credential_reference?: string;
          status?: 'active' | 'suspended' | 'deprovisioned' | 'maintenance';
          capabilities?: string[];
          environment?: 'production' | 'development' | 'staging' | 'sandbox';
          parent_provider_account_id?: string | null;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
      };
      telecom_organization_provider_assignments: {
        Row: {
          id: string;
          organization_id: string;
          provider_account_id: string;
          service_scope: 'ALL' | 'VOICE' | 'SMS' | 'MMS' | 'NUMBER_MANAGEMENT' | 'RECORDING' | 'COMPLIANCE';
          country_code: string | null;
          priority: number;
          is_active: boolean;
          metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          provider_account_id: string;
          service_scope: 'ALL' | 'VOICE' | 'SMS' | 'MMS' | 'NUMBER_MANAGEMENT' | 'RECORDING' | 'COMPLIANCE';
          country_code?: string | null;
          priority?: number;
          is_active?: boolean;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          provider_account_id?: string;
          service_scope?: 'ALL' | 'VOICE' | 'SMS' | 'MMS' | 'NUMBER_MANAGEMENT' | 'RECORDING' | 'COMPLIANCE';
          country_code?: string | null;
          priority?: number;
          is_active?: boolean;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
      };
      telecom_provider_resource_records: {
        Row: {
          id: string;
          organization_id: string;
          provider_account_id: string;
          resource_type: 'PHONE_NUMBER' | 'CALL' | 'MESSAGE' | 'RECORDING' | 'COMPLIANCE_RESOURCE';
          local_resource_id: string;
          remote_resource_id: string;
          provider: string;
          status: string;
          metadata: Json;
          domain_phone_number_id: string | null;
          last_verified_at: string;
          released_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          provider_account_id: string;
          resource_type: 'PHONE_NUMBER' | 'CALL' | 'MESSAGE' | 'RECORDING' | 'COMPLIANCE_RESOURCE';
          local_resource_id: string;
          remote_resource_id: string;
          provider?: string;
          status?: string;
          metadata?: Json;
          domain_phone_number_id?: string | null;
          last_verified_at?: string;
          released_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          provider_account_id?: string;
          resource_type?: 'PHONE_NUMBER' | 'CALL' | 'MESSAGE' | 'RECORDING' | 'COMPLIANCE_RESOURCE';
          local_resource_id?: string;
          remote_resource_id?: string;
          provider?: string;
          status?: string;
          metadata?: Json;
          domain_phone_number_id?: string | null;
          last_verified_at?: string;
          released_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      telecom_account_provisioning_operations: {
        Row: {
          id: string;
          organization_id: string;
          provider: 'TWILIO' | 'TELNYX' | 'BANDWIDTH' | 'AWS_CHIME' | 'OTHER';
          service_scope: 'ALL' | 'VOICE' | 'SMS' | 'MMS' | 'NUMBER_MANAGEMENT' | 'RECORDING' | 'COMPLIANCE';
          idempotency_key: string;
          status: 'REQUESTED' | 'PROVIDER_ACCOUNT_CREATED' | 'RUNTIME_CREDENTIAL_CREATED' | 'WEBHOOK_CREDENTIAL_CAPTURED' | 'SECRETS_STORED' | 'LOCAL_ACCOUNT_RECORDED' | 'ASSIGNMENT_CREATED' | 'READY' | 'FAILED' | 'REQUIRES_RECONCILIATION';
          provider_account_reference: string | null;
          runtime_credential_reference: string | null;
          runtime_key_identifier: string | null;
          webhook_credential_reference: string | null;
          provider_account_id: string | null;
          assignment_id: string | null;
          attempt_count: number;
          last_error_code: string | null;
          last_error_message_sanitized: string | null;
          metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          provider: 'TWILIO' | 'TELNYX' | 'BANDWIDTH' | 'AWS_CHIME' | 'OTHER';
          service_scope?: 'ALL' | 'VOICE' | 'SMS' | 'MMS' | 'NUMBER_MANAGEMENT' | 'RECORDING' | 'COMPLIANCE';
          idempotency_key: string;
          status?: 'REQUESTED' | 'PROVIDER_ACCOUNT_CREATED' | 'RUNTIME_CREDENTIAL_CREATED' | 'WEBHOOK_CREDENTIAL_CAPTURED' | 'SECRETS_STORED' | 'LOCAL_ACCOUNT_RECORDED' | 'ASSIGNMENT_CREATED' | 'READY' | 'FAILED' | 'REQUIRES_RECONCILIATION';
          provider_account_reference?: string | null;
          runtime_credential_reference?: string | null;
          runtime_key_identifier?: string | null;
          webhook_credential_reference?: string | null;
          provider_account_id?: string | null;
          assignment_id?: string | null;
          attempt_count?: number;
          last_error_code?: string | null;
          last_error_message_sanitized?: string | null;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          provider?: 'TWILIO' | 'TELNYX' | 'BANDWIDTH' | 'AWS_CHIME' | 'OTHER';
          service_scope?: 'ALL' | 'VOICE' | 'SMS' | 'MMS' | 'NUMBER_MANAGEMENT' | 'RECORDING' | 'COMPLIANCE';
          idempotency_key?: string;
          status?: 'REQUESTED' | 'PROVIDER_ACCOUNT_CREATED' | 'RUNTIME_CREDENTIAL_CREATED' | 'WEBHOOK_CREDENTIAL_CAPTURED' | 'SECRETS_STORED' | 'LOCAL_ACCOUNT_RECORDED' | 'ASSIGNMENT_CREATED' | 'READY' | 'FAILED' | 'REQUIRES_RECONCILIATION';
          provider_account_reference?: string | null;
          runtime_credential_reference?: string | null;
          runtime_key_identifier?: string | null;
          webhook_credential_reference?: string | null;
          provider_account_id?: string | null;
          assignment_id?: string | null;
          attempt_count?: number;
          last_error_code?: string | null;
          last_error_message_sanitized?: string | null;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
      };
      telecom_vault_secrets: {
        Row: {
          id: string;
          secret_reference: string;
          provider: string;
          secret_type: 'RUNTIME_API' | 'WEBHOOK_VERIFICATION' | 'WEBRTC_TOKEN_SIGNING' | 'ADMINISTRATIVE' | 'GENERAL';
          provider_account_id: string;
          ciphertext: string;
          wrapped_data_key: string;
          iv: string;
          auth_tag: string;
          key_id: string;
          encryption_version: number;
          status: 'active' | 'previous' | 'revoked' | 'deleted';
          metadata: Json;
          created_at: string;
          updated_at: string;
          revoked_at: string | null;
        };
        Insert: {
          id?: string;
          secret_reference: string;
          provider: string;
          secret_type: 'RUNTIME_API' | 'WEBHOOK_VERIFICATION' | 'WEBRTC_TOKEN_SIGNING' | 'ADMINISTRATIVE' | 'GENERAL';
          provider_account_id: string;
          ciphertext: string;
          wrapped_data_key: string;
          iv: string;
          auth_tag: string;
          key_id: string;
          encryption_version?: number;
          status?: 'active' | 'previous' | 'revoked' | 'deleted';
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
          revoked_at?: string | null;
        };
        Update: {
          id?: string;
          secret_reference?: string;
          provider?: string;
          secret_type?: 'RUNTIME_API' | 'WEBHOOK_VERIFICATION' | 'WEBRTC_TOKEN_SIGNING' | 'ADMINISTRATIVE' | 'GENERAL';
          provider_account_id?: string;
          ciphertext?: string;
          wrapped_data_key?: string;
          iv?: string;
          auth_tag?: string;
          key_id?: string;
          encryption_version?: number;
          status?: 'active' | 'previous' | 'revoked' | 'deleted';
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
          revoked_at?: string | null;
        };
        Relationships: {
          foreignKeyName: string;
          columns: string[];
          isOneToOne?: boolean;
          referencedRelation: string;
          referencedColumns: string[];
        }[];
      };
      phone_number_price_quotes: {
        Row: {
          id: string;
          organization_id: string;
          provider: string;
          phone_number_e164: string;
          number_type: 'local' | 'mobile' | 'toll_free' | 'national';
          country_code: string;
          currency: string;
          provider_setup_cost_minor: number;
          provider_recurring_cost_minor: number;
          customer_setup_price_minor: number;
          customer_recurring_price_minor: number;
          pricing_policy_id: string | null;
          observed_at: string;
          expires_at: string;
          search_token_signature: string | null;
          reservation_metadata: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          provider?: string;
          phone_number_e164: string;
          number_type: 'local' | 'mobile' | 'toll_free' | 'national';
          country_code: string;
          currency?: string;
          provider_setup_cost_minor?: number;
          provider_recurring_cost_minor?: number;
          customer_setup_price_minor?: number;
          customer_recurring_price_minor?: number;
          pricing_policy_id?: string | null;
          observed_at?: string;
          expires_at: string;
          search_token_signature?: string | null;
          reservation_metadata?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          provider?: string;
          phone_number_e164?: string;
          number_type?: 'local' | 'mobile' | 'toll_free' | 'national';
          country_code?: string;
          currency?: string;
          provider_setup_cost_minor?: number;
          provider_recurring_cost_minor?: number;
          customer_setup_price_minor?: number;
          customer_recurring_price_minor?: number;
          pricing_policy_id?: string | null;
          observed_at?: string;
          expires_at?: string;
          search_token_signature?: string | null;
          reservation_metadata?: Json;
          created_at?: string;
        };
      };
      phone_number_lifecycle_events: {
        Row: {
          id: string;
          organization_id: string;
          phone_number_id: string;
          phone_number_e164: string;
          event_type: 'PURCHASE_REQUESTED' | 'PURCHASE_CONFIRMED' | 'PURCHASE_FAILED' | 'PURCHASE_RECONCILED' | 'ASSIGNED' | 'UNASSIGNED' | 'ROUTING_CHANGED' | 'SUSPENDED' | 'REACTIVATED' | 'RELEASE_REQUESTED' | 'RELEASE_BLOCKED' | 'RELEASE_CONFIRMED' | 'PORT_IN_REQUESTED' | 'PORT_IN_COMPLETED' | 'PORT_IN_FAILED' | 'PORT_OUT_REQUESTED' | 'PORT_OUT_AUTHORIZED' | 'PORT_OUT_COMPLETED' | 'PORT_FREEZE_CHANGED' | 'COMPLIANCE_CHANGED';
          actor_type: 'USER' | 'SYSTEM' | 'CARRIER_WEBHOOK' | 'CRON_WORKER';
          actor_id: string | null;
          details: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          phone_number_id: string;
          phone_number_e164: string;
          event_type: 'PURCHASE_REQUESTED' | 'PURCHASE_CONFIRMED' | 'PURCHASE_FAILED' | 'PURCHASE_RECONCILED' | 'ASSIGNED' | 'UNASSIGNED' | 'ROUTING_CHANGED' | 'SUSPENDED' | 'REACTIVATED' | 'RELEASE_REQUESTED' | 'RELEASE_BLOCKED' | 'RELEASE_CONFIRMED' | 'PORT_IN_REQUESTED' | 'PORT_IN_COMPLETED' | 'PORT_IN_FAILED' | 'PORT_OUT_REQUESTED' | 'PORT_OUT_AUTHORIZED' | 'PORT_OUT_COMPLETED' | 'PORT_FREEZE_CHANGED' | 'COMPLIANCE_CHANGED';
          actor_type: 'USER' | 'SYSTEM' | 'CARRIER_WEBHOOK' | 'CRON_WORKER';
          actor_id?: string | null;
          details?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          phone_number_id?: string;
          phone_number_e164?: string;
          event_type?: 'PURCHASE_REQUESTED' | 'PURCHASE_CONFIRMED' | 'PURCHASE_FAILED' | 'PURCHASE_RECONCILED' | 'ASSIGNED' | 'UNASSIGNED' | 'ROUTING_CHANGED' | 'SUSPENDED' | 'REACTIVATED' | 'RELEASE_REQUESTED' | 'RELEASE_BLOCKED' | 'RELEASE_CONFIRMED' | 'PORT_IN_REQUESTED' | 'PORT_IN_COMPLETED' | 'PORT_IN_FAILED' | 'PORT_OUT_REQUESTED' | 'PORT_OUT_AUTHORIZED' | 'PORT_OUT_COMPLETED' | 'PORT_FREEZE_CHANGED' | 'COMPLIANCE_CHANGED';
          actor_type?: 'USER' | 'SYSTEM' | 'CARRIER_WEBHOOK' | 'CRON_WORKER';
          actor_id?: string | null;
          details?: Json;
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
      record_telecom_usage_reservation_atomic: {
        Args: {
          p_organization_id: string;
          p_internal_usage_id: string;
          p_service_type: string;
          p_direction: string;
          p_amount_reserved_minor: number;
          p_idempotency_key: string;
          p_expires_in_seconds?: number;
          p_currency?: string;
          p_provider?: string;
          p_provider_resource_id?: string | null;
          p_rate_card_id?: string | null;
          p_rate_snapshot?: Json;
          p_metadata?: Json;
        };
        Returns: {
          success: boolean;
          is_duplicate: boolean;
          reservation_id: string;
          internal_usage_id: string;
          amount_reserved_minor: number;
          status: string;
          expires_at?: string;
          funded_balance_minor: number;
          active_reservations_minor: number;
          available_balance_minor: number;
        };
      };
    };
  };
}
