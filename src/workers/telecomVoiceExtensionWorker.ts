import fs from 'fs';
import path from 'path';

(globalThis as any).WebSocket = class {};

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ActiveCallExtensionService } from '../lib/billing/telecom/activeCallExtensionService';
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

export interface TelecomVoiceExtensionWorkerConfig {
  workerId?: string;
  pollingIntervalMs?: number;
  leaseDurationSeconds?: number;
  extensionBlockSeconds?: number;
  systemOrgId?: string;
  providerAdapter?: TwilioCallControlAdapter;
  supabaseClient?: SupabaseClient;
}

export class TelecomVoiceExtensionWorker {
  private workerId: string;
  private pollingIntervalMs: number;
  private leaseDurationSeconds: number;
  private extensionBlockSeconds: number;
  private systemOrgId: string;
  private isRunning: boolean = false;
  private supabase: SupabaseClient;
  private providerAdapter: TwilioCallControlAdapter;

  constructor(config: TelecomVoiceExtensionWorkerConfig = {}) {
    const pid = process.pid || Math.floor(Math.random() * 10000);
    this.workerId = config.workerId || `worker_daemon_pid_${pid}_${Date.now()}`;
    this.pollingIntervalMs = config.pollingIntervalMs || parseInt(process.env.TELECOM_VOICE_EXTENSION_WORKER_POLL_INTERVAL_MS || '3000', 10);
    this.leaseDurationSeconds = config.leaseDurationSeconds || 30;
    this.extensionBlockSeconds = config.extensionBlockSeconds || 60; // EXPERIMENT_PROVISIONAL
    this.systemOrgId = config.systemOrgId || '00000000-0000-0000-0000-000000000001';

    // Provider adapter MUST default to MockTwilioCallControlAdapter for safety
    this.providerAdapter = config.providerAdapter || new MockTwilioCallControlAdapter();

    if (config.supabaseClient) {
      this.supabase = config.supabaseClient;
    } else {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
      const serviceRoleKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
      if (!supabaseUrl || !serviceRoleKey) {
        throw new Error('[TelecomVoiceExtensionWorker] Missing Supabase environment credentials.');
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
        p_destination_fingerprint: 'telecom_voice_extension_daemon_v1',
        p_status: statusStr,
        p_ttl_seconds: 15,
      });

      if (error) {
        console.warn(`[${this.workerId}] Heartbeat RPC error: ${error.message}`);
        return false;
      }
      return Boolean(data?.success);
    } catch (err: any) {
      console.warn(`[${this.workerId}] Heartbeat exception:`, err.message || err);
      return false;
    }
  }

  /**
   * Executes one single pass of due voice extension processing.
   */
  public async processSinglePass(): Promise<any> {
    return await ActiveCallExtensionService.processNextDueVoiceExtension(this.supabase, {
      workerId: this.workerId,
      leaseDurationSeconds: this.leaseDurationSeconds,
      extensionBlockSeconds: this.extensionBlockSeconds,
      providerAdapter: this.providerAdapter,
    });
  }

  /**
   * Starts the continuous background polling loop.
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      console.log(`[${this.workerId}] Worker is already running.`);
      return;
    }

    this.isRunning = true;
    console.log(`[${this.workerId}] Starting continuous voice extension daemon (poll interval: ${this.pollingIntervalMs}ms)...`);

    await this.sendHeartbeat('STARTING');

    while (this.isRunning) {
      try {
        await this.sendHeartbeat('WAITING_FOR_CALL');

        const result = await this.processSinglePass();

        if (result && result.processed) {
          console.log(`[${this.workerId}] Processed due call:`, {
            status: result.status,
            opStatus: result.opStatus,
            targetCallSid: result.targetCallSid,
            internalUsageId: result.internalUsageId,
            sequenceNumber: result.sequenceNumber,
          });
          // Immediately check for next due call without sleeping
          continue;
        }
      } catch (pollErr: any) {
        console.error(`[${this.workerId}] Poll iteration error:`, pollErr.message || pollErr);
        // Backoff delay on database error
        await new Promise((r) => setTimeout(r, 5000));
      }

      // Sleep for polling interval
      await new Promise((r) => setTimeout(r, this.pollingIntervalMs));
    }

    await this.sendHeartbeat('STOPPED');
    console.log(`[${this.workerId}] Voice extension daemon stopped cleanly.`);
  }

  /**
   * Stops the continuous polling loop gracefully.
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    console.log(`[${this.workerId}] Gracefully stopping worker...`);
    this.isRunning = false;
  }
}

// Standalone CLI execution entrypoint
if (require.main === module) {
  const worker = new TelecomVoiceExtensionWorker();

  const shutdown = async () => {
    console.log('\n[Worker CLI] Received termination signal. Stopping daemon...');
    await worker.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  worker.start().catch((err) => {
    console.error('[Worker CLI Fatal Error]:', err);
    process.exit(1);
  });
}
