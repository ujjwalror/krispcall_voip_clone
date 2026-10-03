import fs from 'fs';
import path from 'path';

(globalThis as any).WebSocket = class {};

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { CreditAutoTopupService } from '../lib/billing/creditAutoTopupService';
import { CreditAutoTopupExecutionService } from '../lib/billing/creditAutoTopupExecutionService';

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

export interface AutoTopupWorkerConfig {
  workerId?: string;
  pollingIntervalMs?: number;
  supabaseClient?: SupabaseClient;
}

export class AutoTopupWorker {
  private workerId: string;
  private pollingIntervalMs: number;
  private isRunning: boolean = false;
  private supabase: SupabaseClient;

  constructor(config: AutoTopupWorkerConfig = {}) {
    const pid = process.pid || Math.floor(Math.random() * 10000);
    this.workerId = config.workerId || `worker_auto_topup_pid_${pid}_${Date.now()}`;
    this.pollingIntervalMs = config.pollingIntervalMs || parseInt(process.env.AUTO_TOPUP_WORKER_POLL_INTERVAL_MS || '10000', 10);

    if (config.supabaseClient) {
      this.supabase = config.supabaseClient;
    } else {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
      const serviceRoleKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
      if (!supabaseUrl || !serviceRoleKey) {
        throw new Error('[AutoTopupWorker] Missing Supabase environment credentials.');
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
   * Executes one single poll & execution pass across all enabled orgs and in-flight triggers.
   */
  public async processSinglePass(): Promise<any> {
    if (process.env.AUTO_TOPUP_WORKER_ENABLED !== 'true') {
      return { status: 'skipped', reason: 'AUTO_TOPUP_WORKER_ENABLED_FALSE' };
    }

    // 1. Discover all enabled Auto Top-Up settings rows
    const { data: enabledSettings } = await (this.supabase as any)
      .from('billing_auto_topup_settings')
      .select('organization_id, threshold_state')
      .eq('status', 'enabled')
      .eq('threshold_state', 'ARMED');

    let claimedCount = 0;
    let executedCount = 0;

    if (enabledSettings && enabledSettings.length > 0) {
      for (const s of enabledSettings) {
        if (!this.isRunning) break;

        // Atomic claim check
        const claimResult = await CreditAutoTopupService.claimAutoTopupTriggerAtomic(
          this.supabase,
          s.organization_id,
          this.workerId
        );

        if (claimResult && claimResult.claimed && claimResult.trigger_id) {
          claimedCount++;

          // Authorize provider mutation
          const authResult = await CreditAutoTopupService.authorizeAutoTopupProviderMutationAtomic(
            this.supabase,
            s.organization_id,
            claimResult.trigger_id
          );

          if (authResult && authResult.success && authResult.authorized !== false) {
            // Execute provider mutation
            const execResult = await CreditAutoTopupExecutionService.executeAuthorizedTrigger(
              this.supabase,
              s.organization_id,
              claimResult.trigger_id
            );
            if (execResult.success) {
              executedCount++;
            }
          }
        }
      }
    }

    // 2. Recover any stale / ambiguous in-flight triggers
    const recoveryResult = await CreditAutoTopupExecutionService.recoverAmbiguousTriggers(this.supabase);

    return {
      status: 'completed',
      claimed: claimedCount,
      executed: executedCount,
      recoveryProcessed: recoveryResult.processed,
    };
  }

  /**
   * Starts continuous background polling loop.
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      console.log(`[${this.workerId}] Auto Top-Up Worker is already running.`);
      return;
    }

    this.isRunning = true;
    console.log(`[${this.workerId}] Starting Auto Top-Up worker daemon (poll interval: ${this.pollingIntervalMs}ms)...`);

    while (this.isRunning) {
      try {
        await this.processSinglePass();
      } catch (err: any) {
        console.error(`[${this.workerId}] Poll exception:`, err.message || err);
      }

      await new Promise((r) => setTimeout(r, this.pollingIntervalMs));
    }

    console.log(`[${this.workerId}] Auto Top-Up worker daemon stopped cleanly.`);
  }

  /**
   * Stops continuous background loop gracefully.
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    console.log(`[${this.workerId}] Gracefully stopping worker...`);
    this.isRunning = false;
  }
}

// Standalone CLI execution entrypoint
if (require.main === module) {
  const worker = new AutoTopupWorker();

  const shutdown = async () => {
    console.log('\n[Auto Top-Up Worker CLI] Received termination signal. Stopping daemon...');
    await worker.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  worker.start().catch((err) => {
    console.error('[Auto Top-Up Worker Fatal Error]:', err);
    process.exit(1);
  });
}
