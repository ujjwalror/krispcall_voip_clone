import { Database } from './database.types';

export * from './database.types';

// Database Entity Row Aliases
export type Organization = Database['public']['Tables']['organizations']['Row'];
export type Profile = Database['public']['Tables']['profiles']['Row'];
export type Contact = Database['public']['Tables']['contacts']['Row'];
export type Call = Database['public']['Tables']['calls']['Row'];
export type Recording = Database['public']['Tables']['recordings']['Row'];
export type Message = Database['public']['Tables']['messages']['Row'];
export type PhoneNumber = Database['public']['Tables']['phone_numbers']['Row'];
export type UserPhoneAssignment = Database['public']['Tables']['user_phone_assignments']['Row'];

// Database Insert & Update Types
export type ContactInsert = Database['public']['Tables']['contacts']['Insert'];
export type CallInsert = Database['public']['Tables']['calls']['Insert'];
export type MessageInsert = Database['public']['Tables']['messages']['Insert'];

// UI Shell Types (Phase 1 Compatibility)
export type AgentStatus = 'online' | 'busy' | 'away' | 'offline';

export interface UserProfile {
  id: string;
  email: string;
  fullName: string;
  avatarUrl?: string;
  role: 'admin' | 'agent';
  status: AgentStatus;
  twilioIdentity?: string;
}

export interface CallLog {
  id: string;
  direction: 'inbound' | 'outbound';
  fromNumber: string;
  toNumber: string;
  contactName?: string;
  durationSeconds: number;
  status: string;
  timestamp: string;
  agentId?: string;
  agentName?: string;
  recordingUrl?: string;
  recordingDuration?: number;
  hasRecording?: boolean;
}

export interface CallRecording {
  id: string;
  callLogId: string;
  contactName?: string;
  phoneNumber: string;
  durationSeconds: number;
  recordingUrl: string;
  timestamp: string;
  agentName?: string;
}
