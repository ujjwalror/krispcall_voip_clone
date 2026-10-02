import fs from 'fs';
import path from 'path';

(globalThis as any).WebSocket = class {};

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { FinancialReconciliationRunnerService } from '../lib/billing/reconciliation/financialReconciliationRunnerService';
import { discoverAuthoritativeOrganizations } from '../lib/billing/reconciliation/reconciliationScopeUtils';

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

export interface FinancialReconciliationWorkerConfig {
  workerId?: string;
  pollingIntervalMs?: number;
  supabaseClient?: SupabaseClient;
}

export class FinancialReconciliationWorker {
  private workerId: string;
  private pollingIntervalMs: number;
  private isRunning: boolean = false;
  private supabase: SupabaseClient;
  private runner: FinancialReconciliationRunnerService;

  constructor(config: FinancialReconciliationWorkerConfig = {}) {
    const pid = process.pid || Math.floor(Math.random() * 10000);
    this.workerId = config.workerId || `worker_financial_recon_pid_${pid}_${Date.now()}`;
    this.pollingIntervalMs = config.pollingIntervalMs || parseInt(process.env.RECONCILIATION_WORKER_POLL_INTERVAL_MS || '1800000', 10); // Default 30 mins

    if (config.supabaseClient) {
      this.supabase = config.supabaseClient;
    } else {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
      const serviceRoleKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
      if (!supabaseUrl || !serviceRoleKey) {
        throw new Error('[FinancialReconciliationWorker] Missing Supabase environment credentials.');
      }
      this.supabase = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }

    this.runner = new FinancialReconciliationRunnerService();
  }

  public getWorkerId(): string {
    return this.workerId;
  }

  public isWorkerRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Executes one single full system & tenant reconciliation sweep pass.
   */
  public async processSinglePass(): Promise<any> {
    if (process.env.RECONCILIATION_ENABLED !== 'true') {
      console.log(`[${this.workerId}] Reconciliation execution gate disabled (RECONCILIATION_ENABLED != true). Skipping sweep.`);
      return { status: 'skipped', reason: 'RECONCILIATION_ENABLED_FALSE' };
    }

    console.log(`[${this.workerId}] Starting authoritative financial reconciliation sweep...`);

    // 1. Discover all financially active and dormant organizations
    const orgs = await discoverAuthoritativeOrganizations(this.supabase);
    console.log(`[${this.workerId}] Discovered ${orgs.length} financially relevant organizations.`);

    let openFindingsTotal = 0;
    let resolvedFindingsTotal = 0;
    let totalInspectedSum = 0;

    for (const orgId of orgs) {
      if (!this.isRunning) break;

      const res = await this.runner.run(this.supabase, {
        runType: 'organization',
        organizationId: orgId,
        workerId: this.workerId,
        environment: (process.env.NEXT_PUBLIC_STRIPE_ENVIRONMENT as 'test' | 'live') || 'test',
      });

      totalInspectedSum += res.summaryCounts.totalInspected;
      openFindingsTotal += res.summaryCounts.findingsOpen;
      resolvedFindingsTotal += res.summaryCounts.findingsResolved;
    }

    console.log(`[${this.workerId}] Sweep complete. Total Inspected: ${totalInspectedSum}, Open Findings: ${openFindingsTotal}, Resolved: ${resolvedFindingsTotal}`);

    return {
      status: 'completed',
      totalInspected: totalInspectedSum,
      openFindings: openFindingsTotal,
      resolvedFindings: resolvedFindingsTotal,
    };
  }

  /**
   * Starts continuous background polling loop (VPS daemon execution).
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      console.log(`[${this.workerId}] Financial Reconciliation Worker is already running.`);
      return;
    }

    this.isRunning = true;
    console.log(`[${this.workerId}] Starting financial reconciliation daemon (poll interval: ${this.pollingIntervalMs}ms)...`);

    while (this.isRunning) {
      try {
        await this.processSinglePass();
      } catch (err: any) {
        console.error(`[${this.workerId}] Poll exception:`, err.message || err);
      }

      // Sleep for polling interval
      await new Promise((r) => setTimeout(r, this.pollingIntervalMs));
    }

    console.log(`[${this.workerId}] Financial reconciliation daemon stopped cleanly.`);
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
  const worker = new FinancialReconciliationWorker();

  const shutdown = async () => {
    console.log('\n[Financial Reconciliation Worker CLI] Received termination signal. Stopping daemon...');
    await worker.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  worker.start().catch((err) => {
    console.error('[Financial Reconciliation Worker Fatal Error]:', err);
    process.exit(1);
  });
}
