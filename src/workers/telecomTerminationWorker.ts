import fs from 'fs';
import path from 'path';

(globalThis as any).WebSocket = class {};

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ActiveCallTerminationService } from '../lib/billing/telecom/activeCallTerminationService';
import { MockTwilioCallControlAdapter, TwilioCallControlAdapter } from '../lib/telephony/twilioCallControlAdapter';

// Load .env.local if present
const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (key && !process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

export interface TelecomTerminationWorkerConfig {
  workerId?: string;
  pollingIntervalMs?: number;
  systemOrgId?: string;
  providerAdapter?: TwilioCallControlAdapter;
  supabaseClient?: SupabaseClient;
}

export class TelecomTerminationWorker {
  private workerId: string;
  private pollingIntervalMs: number;
  private systemOrgId: string;
  private isRunning: boolean = false;
  private supabase: SupabaseClient;
  private providerAdapter: TwilioCallControlAdapter;

  constructor(config: TelecomTerminationWorkerConfig = {}) {
    const pid = process.pid || Math.floor(Math.random() * 10000);
    this.workerId = config.workerId || `worker_terminator_pid_${pid}_${Date.now()}`;
    this.pollingIntervalMs = config.pollingIntervalMs || parseInt(process.env.TELECOM_TERMINATION_WORKER_POLL_INTERVAL_MS || '4000', 10);
    this.systemOrgId = config.systemOrgId || '00000000-0000-0000-0000-000000000001';

    // Provider adapter MUST default to MockTwilioCallControlAdapter for safety
    this.providerAdapter = config.providerAdapter || new MockTwilioCallControlAdapter();

    if (config.supabaseClient) {
      this.supabase = config.supabaseClient;
    } else {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
      const serviceRoleKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
      if (!supabaseUrl || !serviceRoleKey) {
        throw new Error('[TelecomTerminationWorker] Missing Supabase environment credentials.');
      }
      this.supabase = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
  }

  public getWorkerId(): string {
    return this.workerId;
  }

  public isWorkerRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Registers or updates server-authoritative heartbeat in telecom_runner_heartbeats.
   */
  public async sendHeartbeat(statusStr: string = 'WAITING_FOR_CALL'): Promise<boolean> {
    try {
      const { data, error } = await (this.supabase as any).rpc('register_telecom_runner_heartbeat_atomic', {
        p_runner_id: this.workerId,
        p_organization_id: this.systemOrgId,
        p_authorization_id: null,
        p_destination_fingerprint: 'telecom_termination_daemon_v1',
        p_status: statusStr,
        p_ttl_seconds: 15,
      });

      if (error) {
        console.warn(`[${this.workerId}] Termination Heartbeat RPC error: ${error.message}`);
        return false;
      }
      return Boolean(data?.success);
    } catch (err: any) {
      console.warn(`[${this.workerId}] Termination Heartbeat exception:`, err.message || err);
      return false;
    }
  }

  /**
   * Executes one single pass of due active call termination.
   */
  public async processSinglePass(): Promise<any> {
    // Discover calls needing termination (e.g. calls with status in-progress whose reservations are expired/failed)
    const { data: calls, error: fetchErr } = await this.supabase
      .from('calls')
      .select('id, organization_id, status')
      .eq('status', 'in-progress')
      .limit(1);

    if (fetchErr || !calls || calls.length === 0) {
      return { processed: false, reason: 'NO_DUE_TERMINATIONS' };
    }

    const targetCall = calls[0];
    const termRes = await ActiveCallTerminationService.terminateActiveCall(this.supabase, {
      organizationId: targetCall.organization_id,
      dbCallId: targetCall.id,
      reason: 'credit_exhausted',
      providerAdapter: this.providerAdapter,
      workerId: this.workerId,
    });

    return {
      processed: true,
      ...termRes,
    };
  }

  /**
   * Starts the continuous background polling loop.
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      console.log(`[${this.workerId}] Termination Worker is already running.`);
      return;
    }

    this.isRunning = true;
    console.log(`[${this.workerId}] Starting continuous termination daemon (poll interval: ${this.pollingIntervalMs}ms)...`);

    await this.sendHeartbeat('STARTING');

    while (this.isRunning) {
      try {
        await this.sendHeartbeat('WAITING_FOR_CALL');

        const result = await this.processSinglePass();

        if (result && result.processed) {
          console.log(`[${this.workerId}] Processed termination:`, {
            outcome: result.outcome,
            targetCallSid: result.targetCallSid,
            dbCallId: result.dbCallId,
          });
          continue;
        }
      } catch (pollErr: any) {
        console.error(`[${this.workerId}] Termination poll error:`, pollErr.message || pollErr);
        await new Promise((r) => setTimeout(r, 5000));
      }

      await new Promise((r) => setTimeout(r, this.pollingIntervalMs));
    }

    await this.sendHeartbeat('STOPPED');
    console.log(`[${this.workerId}] Termination daemon stopped cleanly.`);
  }

  /**
   * Stops the continuous polling loop gracefully.
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    console.log(`[${this.workerId}] Gracefully stopping termination worker...`);
    this.isRunning = false;
  }
}

// Standalone CLI execution entrypoint
if (require.main === module) {
  const worker = new TelecomTerminationWorker();

  const shutdown = async () => {
    console.log('\n[Termination Worker CLI] Received termination signal. Stopping daemon...');
    await worker.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  worker.start().catch((err) => {
    console.error('[Termination Worker CLI Fatal Error]:', err);
    process.exit(1);
  });
}
