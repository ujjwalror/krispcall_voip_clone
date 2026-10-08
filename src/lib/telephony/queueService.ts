import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { hasEntitlement } from '@/lib/entitlements/server';

export type QueueStrategy = 'fifo' | 'round_robin' | 'longest_idle';
export type QueueEntryStatus = 'waiting' | 'offering' | 'connected' | 'completed' | 'abandoned' | 'timed_out' | 'failed';
export type FallbackDestinationType = 'user' | 'ivr' | 'voicemail' | 'hangup';

export interface CallQueueDTO {
  id: string;
  organizationId: string;
  name: string;
  enabled: boolean;
  strategy: QueueStrategy;
  maxWaitSeconds: number;
  ringTimeoutSeconds: number;
  greetingType: 'tts' | 'audio_url';
  greetingText: string;
  greetingAudioUrl: string | null;
  fallbackDestinationType: FallbackDestinationType;
  fallbackDestinationId: string | null;
  createdAt: string;
  updatedAt: string;
  members?: CallQueueMemberDTO[];
}

export interface CallQueueMemberDTO {
  id: string;
  organizationId: string;
  queueId: string;
  userId: string;
  enabled: boolean;
  priority: number;
  lastOfferedAt: string | null;
  createdAt: string;
  updatedAt: string;
  profile?: {
    id: string;
    fullName: string | null;
    email: string | null;
    availabilityStatus: string;
    lastSeenAt: string | null;
    active: boolean;
  };
}

export interface CallQueueEntryDTO {
  id: string;
  organizationId: string;
  queueId: string;
  callId: string | null;
  providerCallSid: string;
  callerPhoneNumber: string;
  status: QueueEntryStatus;
  assignedAgentId: string | null;
  enteredAt: string;
  offeredAt: string | null;
  connectedAt: string | null;
  completedAt: string | null;
  abandonedAt: string | null;
  timedOutAt: string | null;
  waitDurationSeconds: number;
  talkDurationSeconds: number;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface QueueDashboardMetrics {
  waitingCallersCount: number;
  activeCallsCount: number;
  availableAgentsCount: number;
  busyAgentsCount: number;
  longestWaitSeconds: number;
  abandonedTodayCount: number;
  waitingCallers: CallQueueEntryDTO[];
  activeCalls: CallQueueEntryDTO[];
  agentPresence: Array<{
    userId: string;
    fullName: string | null;
    email: string | null;
    status: 'available' | 'ringing' | 'on_call' | 'offline';
    lastSeenAt: string | null;
    queueNames: string[];
  }>;
}

export class QueueService {
  /**
   * Creates a new Call Queue for an organization.
   */
  static async createQueue(
    organizationId: string,
    data: {
      name: string;
      strategy?: QueueStrategy;
      maxWaitSeconds?: number;
      ringTimeoutSeconds?: number;
      greetingType?: 'tts' | 'audio_url';
      greetingText?: string;
      greetingAudioUrl?: string | null;
      fallbackDestinationType?: FallbackDestinationType;
      fallbackDestinationId?: string | null;
      enabled?: boolean;
    },
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; queue?: CallQueueDTO; message: string }> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    // 1. Enforce entitlement
    const entitled = await hasEntitlement('call_queue', supabase);
    if (!entitled) {
      return { success: false, message: 'Call Queue feature is not enabled for your subscription plan.' };
    }

    // 2. Validate input
    if (!data.name || !data.name.trim()) {
      return { success: false, message: 'Queue name is required.' };
    }

    const { data: queueRow, error } = await (supabase as any)
      .from('call_queues')
      .insert({
        organization_id: organizationId,
        name: data.name.trim(),
        enabled: data.enabled !== false,
        strategy: data.strategy || 'fifo',
        max_wait_seconds: Math.max(10, Math.min(3600, data.maxWaitSeconds || 300)),
        ring_timeout_seconds: Math.max(5, Math.min(120, data.ringTimeoutSeconds || 20)),
        greeting_type: data.greetingType || 'tts',
        greeting_text: data.greetingText || 'Thank you for calling. Please hold while we connect you to an available agent.',
        greeting_audio_url: data.greetingAudioUrl || null,
        fallback_destination_type: data.fallbackDestinationType || 'voicemail',
        fallback_destination_id: data.fallbackDestinationId || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select('*')
      .single();

    if (error || !queueRow) {
      return { success: false, message: `Failed to create call queue: ${error?.message || 'DB error'}` };
    }

    return {
      success: true,
      queue: this.mapQueueRow(queueRow),
      message: 'Call queue created successfully.',
    };
  }

  /**
   * Retrieves a Call Queue by ID for an organization.
   */
  static async getQueue(
    organizationId: string,
    queueId: string,
    clientOverride?: SupabaseClient
  ): Promise<CallQueueDTO | null> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    const { data: queueRow } = await (supabase as any)
      .from('call_queues')
      .select('*, call_queue_members(*, profiles(id, full_name, email, availability_status, last_seen_at, active))')
      .eq('id', queueId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!queueRow) return null;
    return this.mapQueueRow(queueRow);
  }

  /**
   * Lists all Call Queues for an organization.
   */
  static async listQueues(
    organizationId: string,
    clientOverride?: SupabaseClient
  ): Promise<CallQueueDTO[]> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    const { data: rows } = await (supabase as any)
      .from('call_queues')
      .select('*, call_queue_members(*, profiles(id, full_name, email, availability_status, last_seen_at, active))')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true });

    return (rows || []).map((r: any) => this.mapQueueRow(r));
  }

  /**
   * Updates an existing Call Queue.
   */
  static async updateQueue(
    organizationId: string,
    queueId: string,
    updates: Partial<{
      name: string;
      enabled: boolean;
      strategy: QueueStrategy;
      maxWaitSeconds: number;
      ringTimeoutSeconds: number;
      greetingType: 'tts' | 'audio_url';
      greetingText: string;
      greetingAudioUrl: string | null;
      fallbackDestinationType: FallbackDestinationType;
      fallbackDestinationId: string | null;
    }>,
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; queue?: CallQueueDTO; message: string }> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    const entitled = await hasEntitlement('call_queue', supabase);
    if (!entitled) {
      return { success: false, message: 'Call Queue feature is not enabled for your subscription plan.' };
    }

    const payload: Record<string, any> = { updated_at: new Date().toISOString() };
    if (updates.name !== undefined) payload.name = updates.name.trim();
    if (updates.enabled !== undefined) payload.enabled = updates.enabled;
    if (updates.strategy !== undefined) payload.strategy = updates.strategy;
    if (updates.maxWaitSeconds !== undefined) payload.max_wait_seconds = Math.max(10, Math.min(3600, updates.maxWaitSeconds));
    if (updates.ringTimeoutSeconds !== undefined) payload.ring_timeout_seconds = Math.max(5, Math.min(120, updates.ringTimeoutSeconds));
    if (updates.greetingType !== undefined) payload.greeting_type = updates.greetingType;
    if (updates.greetingText !== undefined) payload.greeting_text = updates.greetingText;
    if (updates.greetingAudioUrl !== undefined) payload.greeting_audio_url = updates.greetingAudioUrl;
    if (updates.fallbackDestinationType !== undefined) payload.fallback_destination_type = updates.fallbackDestinationType;
    if (updates.fallbackDestinationId !== undefined) payload.fallback_destination_id = updates.fallbackDestinationId;

    const { data: updatedRow, error } = await (supabase as any)
      .from('call_queues')
      .update(payload)
      .eq('id', queueId)
      .eq('organization_id', organizationId)
      .select('*')
      .single();

    if (error || !updatedRow) {
      return { success: false, message: `Failed to update queue: ${error?.message || 'Queue not found'}` };
    }

    return {
      success: true,
      queue: this.mapQueueRow(updatedRow),
      message: 'Call queue updated successfully.',
    };
  }

  /**
   * Disables/archives a Call Queue safely.
   */
  static async deleteQueue(
    organizationId: string,
    queueId: string,
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; message: string }> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    const { error } = await (supabase as any)
      .from('call_queues')
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .eq('id', queueId)
      .eq('organization_id', organizationId);

    if (error) {
      return { success: false, message: `Failed to disable queue: ${error.message}` };
    }

    return { success: true, message: 'Call queue disabled successfully.' };
  }

  /**
   * Adds an organization agent/user to a Call Queue.
   */
  static async addQueueMember(
    organizationId: string,
    queueId: string,
    userId: string,
    priority: number = 1,
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; member?: CallQueueMemberDTO; message: string }> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    // Verify target user belongs to organization
    const { data: userProfile } = await (supabase as any)
      .from('profiles')
      .select('id, organization_id, active')
      .eq('id', userId)
      .maybeSingle();

    if (!userProfile || userProfile.organization_id !== organizationId || userProfile.active === false) {
      return { success: false, message: 'Target user does not belong to your organization or is inactive.' };
    }

    // Verify queue exists and belongs to org
    const { data: queue } = await (supabase as any)
      .from('call_queues')
      .select('id, organization_id')
      .eq('id', queueId)
      .maybeSingle();

    if (!queue || queue.organization_id !== organizationId) {
      return { success: false, message: 'Call queue not found or does not belong to your organization.' };
    }

    const { data: memberRow, error } = await (supabase as any)
      .from('call_queue_members')
      .upsert(
        {
          organization_id: organizationId,
          queue_id: queueId,
          user_id: userId,
          priority: Math.max(1, priority),
          enabled: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'queue_id,user_id' }
      )
      .select('*, profiles(id, full_name, email, availability_status, last_seen_at, active)')
      .single();

    if (error || !memberRow) {
      return { success: false, message: `Failed to add agent to queue: ${error?.message || 'DB error'}` };
    }

    return {
      success: true,
      member: this.mapMemberRow(memberRow),
      message: 'Agent added to queue successfully.',
    };
  }

  /**
   * Removes an agent from a Call Queue.
   */
  static async removeQueueMember(
    organizationId: string,
    queueId: string,
    memberId: string,
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; message: string }> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    const { error } = await (supabase as any)
      .from('call_queue_members')
      .delete()
      .eq('id', memberId)
      .eq('queue_id', queueId)
      .eq('organization_id', organizationId);

    if (error) {
      return { success: false, message: `Failed to remove member: ${error.message}` };
    }

    return { success: true, message: 'Queue member removed successfully.' };
  }

  /**
   * Enqueues an inbound caller into a Call Queue.
   */
  static async enqueueCaller(
    organizationId: string,
    queueId: string,
    providerCallSid: string,
    callerPhoneNumber: string = 'Anonymous',
    callId: string | null = null,
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; entry?: CallQueueEntryDTO; message: string; fallbackNeeded?: boolean }> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    // 1. Enforce feature entitlement
    const entitled = await hasEntitlement('call_queue', supabase);
    if (!entitled) {
      return { success: false, message: 'Call Queue feature is not enabled for your subscription plan.', fallbackNeeded: true };
    }

    // 2. Validate Queue ownership and status
    const { data: queue } = await (supabase as any)
      .from('call_queues')
      .select('*')
      .eq('id', queueId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!queue || queue.enabled === false) {
      return { success: false, message: 'Call queue does not exist or is disabled.', fallbackNeeded: true };
    }

    // 3. Verify prepaid wallet authorization
    const { data: wallet } = await (supabase as any)
      .from('telecom_wallets')
      .select('spendable_balance_minor')
      .eq('organization_id', organizationId)
      .maybeSingle();

    const spendableBalanceMinor = wallet?.spendable_balance_minor || 0;
    if (spendableBalanceMinor <= 0) {
      return { success: false, message: 'Insufficient telecom credit balance for queue waiting.', fallbackNeeded: true };
    }

    // 4. Idempotently insert or update queue entry by providerCallSid
    const now = new Date().toISOString();
    const { data: existing } = await (supabase as any)
      .from('call_queue_entries')
      .select('*')
      .eq('provider_call_sid', providerCallSid)
      .maybeSingle();

    if (existing) {
      return {
        success: true,
        entry: this.mapEntryRow(existing),
        message: 'Caller already enqueued.',
      };
    }

    const { data: newEntry, error } = await (supabase as any)
      .from('call_queue_entries')
      .insert({
        organization_id: organizationId,
        queue_id: queueId,
        call_id: callId,
        provider_call_sid: providerCallSid,
        caller_phone_number: callerPhoneNumber,
        status: 'waiting',
        entered_at: now,
        created_at: now,
        updated_at: now,
      })
      .select('*')
      .single();

    if (error || !newEntry) {
      return { success: false, message: `Failed to enqueue caller: ${error?.message || 'DB error'}`, fallbackNeeded: true };
    }

    // Trigger atomic dispatch attempt immediately
    const dispatchRes = await this.dispatchNextCaller(queueId, supabase);
    const finalEntry = (dispatchRes?.claimed && dispatchRes.entry) ? dispatchRes.entry : this.mapEntryRow(newEntry);

    return {
      success: true,
      entry: finalEntry,
      message: 'Caller enqueued successfully.',
    };
  }

  /**
   * Atomic dispatch engine: Claims oldest WAITING caller and assigns to next AVAILABLE agent.
   */
  static async dispatchNextCaller(
    queueId: string,
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; claimed?: boolean; entry?: CallQueueEntryDTO; assignedAgentId?: string }> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    // Fetch queue details
    const { data: queue } = await (supabase as any)
      .from('call_queues')
      .select('id, organization_id, strategy, ring_timeout_seconds, max_wait_seconds, enabled')
      .eq('id', queueId)
      .maybeSingle();

    if (!queue || !queue.enabled) {
      return { success: false, claimed: false };
    }

    // Fetch oldest WAITING caller (FIFO)
    const { data: waitingEntry } = await (supabase as any)
      .from('call_queue_entries')
      .select('*')
      .eq('queue_id', queueId)
      .eq('status', 'waiting')
      .order('entered_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!waitingEntry) {
      return { success: true, claimed: false };
    }

    // Check if caller has exceeded max wait time
    const waitTimeSec = (Date.now() - new Date(waitingEntry.entered_at).getTime()) / 1000;
    if (waitTimeSec >= queue.max_wait_seconds) {
      await this.handleQueueTimeout(waitingEntry.id, supabase);
      return { success: true, claimed: false };
    }

    // Fetch eligible queue members (agents)
    const { data: members } = await (supabase as any)
      .from('call_queue_members')
      .select('*, profiles(id, full_name, email, availability_status, last_seen_at, active)')
      .eq('queue_id', queueId)
      .eq('enabled', true)
      .order('priority', { ascending: true });

    if (!members || members.length === 0) {
      return { success: true, claimed: false };
    }

    // Filter available agents
    const nowMs = Date.now();
    const staleThresholdMs = 5 * 60 * 1000; // 5 minutes heartbeat cutoff

    const availableMembers = members.filter((m: any) => {
      const p = m.profiles;
      if (!p || !p.active) return false;
      if (p.availability_status !== 'available') return false;

      // Check last seen staleness
      if (p.last_seen_at) {
        const lastSeenMs = new Date(p.last_seen_at).getTime();
        if (nowMs - lastSeenMs > staleThresholdMs) return false;
      }
      return true;
    });

    if (availableMembers.length === 0) {
      return { success: true, claimed: false };
    }

    // Check if any candidate agent is currently RINGING or ON_CALL in another active entry
    const candidateUserIds = availableMembers.map((m: any) => m.user_id);
    const { data: activeAgentEntries } = await (supabase as any)
      .from('call_queue_entries')
      .select('assigned_agent_id')
      .in('assigned_agent_id', candidateUserIds)
      .in('status', ['offering', 'connected']);

    const busyAgentIds = new Set((activeAgentEntries || []).map((e: any) => e.assigned_agent_id));
    const trulyAvailableMembers = availableMembers.filter((m: any) => !busyAgentIds.has(m.user_id));

    if (trulyAvailableMembers.length === 0) {
      return { success: true, claimed: false };
    }

    // Agent selection based on strategy
    let selectedMember = trulyAvailableMembers[0];
    if (queue.strategy === 'longest_idle') {
      trulyAvailableMembers.sort((a: any, b: any) => {
        const timeA = a.last_offered_at ? new Date(a.last_offered_at).getTime() : 0;
        const timeB = b.last_offered_at ? new Date(b.last_offered_at).getTime() : 0;
        return timeA - timeB;
      });
      selectedMember = trulyAvailableMembers[0];
    }

    const nowIso = new Date().toISOString();

    // Atomic conditional update: Claim waiting caller
    const { data: claimedEntry, error: claimErr } = await (supabase as any)
      .from('call_queue_entries')
      .update({
        status: 'offering',
        assigned_agent_id: selectedMember.user_id,
        offered_at: nowIso,
        attempt_count: (waitingEntry.attempt_count || 0) + 1,
        updated_at: nowIso,
      })
      .eq('id', waitingEntry.id)
      .eq('status', 'waiting') // Atomic CAS check
      .select('*')
      .single();

    if (claimErr || !claimedEntry) {
      // Claim lost to concurrent worker
      return { success: true, claimed: false };
    }

    // Update last_offered_at on member
    await (supabase as any)
      .from('call_queue_members')
      .update({ last_offered_at: nowIso })
      .eq('id', selectedMember.id);

    return {
      success: true,
      claimed: true,
      entry: this.mapEntryRow(claimedEntry),
      assignedAgentId: selectedMember.user_id,
    };
  }

  /**
   * Transitions queue entry to CONNECTED when agent answers call.
   */
  static async handleAgentAnswer(
    queueEntryId: string,
    agentId: string,
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; entry?: CallQueueEntryDTO }> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    const { data: entry } = await (supabase as any)
      .from('call_queue_entries')
      .select('*')
      .eq('id', queueEntryId)
      .maybeSingle();

    if (!entry) return { success: false };

    const nowIso = new Date().toISOString();
    const waitSec = Math.round((new Date(nowIso).getTime() - new Date(entry.entered_at).getTime()) / 1000);

    const { data: updated, error } = await (supabase as any)
      .from('call_queue_entries')
      .update({
        status: 'connected',
        assigned_agent_id: agentId,
        connected_at: nowIso,
        wait_duration_seconds: Math.max(0, waitSec),
        updated_at: nowIso,
      })
      .eq('id', queueEntryId)
      .select('*')
      .single();

    if (error || !updated) return { success: false };

    return { success: true, entry: this.mapEntryRow(updated) };
  }

  /**
   * Reconciles call status callbacks and disconnects.
   */
  static async handleCallDisconnect(
    providerCallSid: string,
    finalStatus: 'completed' | 'abandoned' | 'failed' | 'no-answer',
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; entry?: CallQueueEntryDTO }> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    const { data: entry } = await (supabase as any)
      .from('call_queue_entries')
      .select('*')
      .eq('provider_call_sid', providerCallSid)
      .maybeSingle();

    if (!entry || ['completed', 'abandoned', 'timed_out', 'failed'].includes(entry.status)) {
      return { success: true };
    }

    const nowIso = new Date().toISOString();
    let newStatus: QueueEntryStatus = 'completed';
    let talkSec = 0;

    if (entry.status === 'waiting') {
      newStatus = 'abandoned';
    } else if (entry.status === 'offering' && finalStatus === 'no-answer') {
      // Requeue caller if agent did not answer
      await (supabase as any)
        .from('call_queue_entries')
        .update({
          status: 'waiting',
          assigned_agent_id: null,
          offered_at: null,
          updated_at: nowIso,
        })
        .eq('id', entry.id);

      // Re-trigger dispatch for another agent
      await this.dispatchNextCaller(entry.queue_id, supabase);
      return { success: true };
    } else if (entry.status === 'connected') {
      newStatus = 'completed';
      if (entry.connected_at) {
        talkSec = Math.round((new Date(nowIso).getTime() - new Date(entry.connected_at).getTime()) / 1000);
      }
    } else if (finalStatus === 'abandoned') {
      newStatus = 'abandoned';
    }

    const { data: updated } = await (supabase as any)
      .from('call_queue_entries')
      .update({
        status: newStatus,
        completed_at: newStatus === 'completed' ? nowIso : entry.completed_at,
        abandoned_at: newStatus === 'abandoned' ? nowIso : entry.abandoned_at,
        talk_duration_seconds: Math.max(0, talkSec),
        updated_at: nowIso,
      })
      .eq('id', entry.id)
      .select('*')
      .single();

    return { success: true, entry: updated ? this.mapEntryRow(updated) : undefined };
  }

  /**
   * Handles max wait timeout for a queue entry.
   */
  static async handleQueueTimeout(
    queueEntryId: string,
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; entry?: CallQueueEntryDTO }> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    const nowIso = new Date().toISOString();
    const { data: updated } = await (supabase as any)
      .from('call_queue_entries')
      .update({
        status: 'timed_out',
        timed_out_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', queueEntryId)
      .select('*')
      .single();

    if (!updated) return { success: false };
    return { success: true, entry: this.mapEntryRow(updated) };
  }

  /**
   * Computes authoritative live dashboard metrics for an organization.
   */
  static async getDashboardMetrics(
    organizationId: string,
    clientOverride?: SupabaseClient
  ): Promise<QueueDashboardMetrics> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    // 1. Fetch active waiting entries
    const { data: waitingRows } = await (supabase as any)
      .from('call_queue_entries')
      .select('*, call_queues(name)')
      .eq('organization_id', organizationId)
      .eq('status', 'waiting')
      .order('entered_at', { ascending: true });

    // 2. Fetch active connected / on-call entries
    const { data: activeRows } = await (supabase as any)
      .from('call_queue_entries')
      .select('*, call_queues(name)')
      .eq('organization_id', organizationId)
      .in('status', ['offering', 'connected'])
      .order('connected_at', { ascending: true });

    // 3. Compute longest wait
    const nowMs = Date.now();
    let longestWait = 0;
    if (waitingRows && waitingRows.length > 0) {
      const oldestEntryMs = new Date(waitingRows[0].entered_at).getTime();
      longestWait = Math.max(0, Math.round((nowMs - oldestEntryMs) / 1000));
    }

    // 4. Compute abandoned today
    const startOfTodayIso = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    const { count: abandonedCount } = await (supabase as any)
      .from('call_queue_entries')
      .select('id', { count: 'exact' })
      .eq('organization_id', organizationId)
      .eq('status', 'abandoned')
      .gte('abandoned_at', startOfTodayIso);

    // 5. Fetch agents and presence
    const { data: agentMembers } = await (supabase as any)
      .from('call_queue_members')
      .select('*, call_queues(name), profiles(id, full_name, email, availability_status, last_seen_at, active)')
      .eq('organization_id', organizationId);

    const agentMap = new Map<string, {
      userId: string;
      fullName: string | null;
      email: string | null;
      status: 'available' | 'ringing' | 'on_call' | 'offline';
      lastSeenAt: string | null;
      queueNames: Set<string>;
    }>();

    const staleThresholdMs = 5 * 60 * 1000;
    const activeOnCallAgents = new Set((activeRows || []).filter((r: any) => r.status === 'connected').map((r: any) => r.assigned_agent_id));
    const activeRingingAgents = new Set((activeRows || []).filter((r: any) => r.status === 'offering').map((r: any) => r.assigned_agent_id));

    (agentMembers || []).forEach((m: any) => {
      const p = m.profiles;
      if (!p || !p.active) return;

      let status: 'available' | 'ringing' | 'on_call' | 'offline' = 'offline';
      if (activeOnCallAgents.has(p.id)) {
        status = 'on_call';
      } else if (activeRingingAgents.has(p.id)) {
        status = 'ringing';
      } else if (p.availability_status === 'available') {
        const lastSeenMs = p.last_seen_at ? new Date(p.last_seen_at).getTime() : 0;
        status = (nowMs - lastSeenMs <= staleThresholdMs) ? 'available' : 'offline';
      }

      if (!agentMap.has(p.id)) {
        agentMap.set(p.id, {
          userId: p.id,
          fullName: p.full_name,
          email: p.email,
          status,
          lastSeenAt: p.last_seen_at,
          queueNames: new Set<string>(),
        });
      }

      if (m.call_queues?.name) {
        agentMap.get(p.id)!.queueNames.add(m.call_queues.name);
      }
    });

    const agentPresenceList = Array.from(agentMap.values()).map(a => ({
      ...a,
      queueNames: Array.from(a.queueNames),
    }));

    const availableCount = agentPresenceList.filter(a => a.status === 'available').length;
    const busyCount = agentPresenceList.filter(a => a.status === 'ringing' || a.status === 'on_call').length;

    return {
      waitingCallersCount: (waitingRows || []).length,
      activeCallsCount: (activeRows || []).length,
      availableAgentsCount: availableCount,
      busyAgentsCount: busyCount,
      longestWaitSeconds: longestWait,
      abandonedTodayCount: abandonedCount || 0,
      waitingCallers: (waitingRows || []).map((r: any) => this.mapEntryRow(r)),
      activeCalls: (activeRows || []).map((r: any) => this.mapEntryRow(r)),
      agentPresence: agentPresenceList,
    };
  }

  // --- MAPPING HELPERS ---
  private static mapQueueRow(row: any): CallQueueDTO {
    return {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      enabled: row.enabled !== false,
      strategy: row.strategy || 'fifo',
      maxWaitSeconds: row.max_wait_seconds || 300,
      ringTimeoutSeconds: row.ring_timeout_seconds || 20,
      greetingType: row.greeting_type || 'tts',
      greetingText: row.greeting_text || '',
      greetingAudioUrl: row.greeting_audio_url || null,
      fallbackDestinationType: row.fallback_destination_type || 'voicemail',
      fallbackDestinationId: row.fallback_destination_id || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      members: row.call_queue_members ? row.call_queue_members.map((m: any) => this.mapMemberRow(m)) : undefined,
    };
  }

  private static mapMemberRow(row: any): CallQueueMemberDTO {
    return {
      id: row.id,
      organizationId: row.organization_id,
      queueId: row.queue_id,
      userId: row.user_id,
      enabled: row.enabled !== false,
      priority: row.priority || 1,
      lastOfferedAt: row.last_offered_at || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      profile: row.profiles
        ? {
            id: row.profiles.id,
            fullName: row.profiles.full_name || null,
            email: row.profiles.email || null,
            availabilityStatus: row.profiles.availability_status || 'available',
            lastSeenAt: row.profiles.last_seen_at || null,
            active: row.profiles.active !== false,
          }
        : undefined,
    };
  }

  private static mapEntryRow(row: any): CallQueueEntryDTO {
    return {
      id: row.id,
      organizationId: row.organization_id,
      queueId: row.queue_id,
      callId: row.call_id || null,
      providerCallSid: row.provider_call_sid,
      callerPhoneNumber: row.caller_phone_number || 'Anonymous',
      status: row.status || 'waiting',
      assignedAgentId: row.assigned_agent_id || null,
      enteredAt: row.entered_at,
      offeredAt: row.offered_at || null,
      connectedAt: row.connected_at || null,
      completedAt: row.completed_at || null,
      abandonedAt: row.abandoned_at || null,
      timedOutAt: row.timed_out_at || null,
      waitDurationSeconds: row.wait_duration_seconds || 0,
      talkDurationSeconds: row.talk_duration_seconds || 0,
      attemptCount: row.attempt_count || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
