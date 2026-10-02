import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { FinancialReconciliationRunnerService } from '../src/lib/billing/reconciliation/financialReconciliationRunnerService';
import { ReconciliationRunType, TargetEntityType } from '../src/lib/billing/reconciliation/reconciliationTypes';

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

async function main() {
  const args = process.argv.slice(2);

  const getArg = (flag: string): string | null => {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) {
      return args[idx + 1];
    }
    return null;
  };

  const hasFlag = (flag: string): boolean => args.includes(flag);

  const scopeArg = (getArg('--scope') || 'full_system') as ReconciliationRunType;
  const orgIdArg = getArg('--org');
  const providerAccountIdArg = getArg('--provider-account');
  const targetedEntityTypeArg = getArg('--entity-type') as TargetEntityType;
  const targetedEntityIdArg = getArg('--entity-id');
  const isReportMode = hasFlag('--report');
  const isDryRun = hasFlag('--dry-run');

  console.log('=== PUBLIC SAAS RECONCILIATION OPERATOR CLI ===');
  console.log(`Mode: OBSERVE ONLY (Zero Financial Mutations) | Dry-Run Notice: ${isDryRun ? 'ENABLED' : 'STANDARD'}`);
  console.log(`Requested Scope: ${scopeArg}\n`);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('FATAL CLI ERROR: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const runner = new FinancialReconciliationRunnerService();

  const startTime = Date.now();
  const result = await runner.run(supabase, {
    runType: scopeArg,
    organizationId: orgIdArg || undefined,
    providerAccountId: providerAccountIdArg || undefined,
    targetedEntityType: targetedEntityTypeArg || undefined,
    targetedEntityId: targetedEntityIdArg || undefined,
    workerId: `cli_operator_${process.pid}_${Date.now()}`,
    environment: (process.env.NEXT_PUBLIC_STRIPE_ENVIRONMENT as 'test' | 'live') || 'test',
  });

  const durationMs = Date.now() - startTime;

  console.log('=== EXECUTION SUMMARY ===');
  console.log(`Run ID: ${result.runId || 'N/A'}`);
  console.log(`Status: ${result.status.toUpperCase()}`);
  console.log(`Duration: ${durationMs}ms`);
  console.log(`Total Inspected: ${result.summaryCounts.totalInspected}`);
  console.log(`Findings Open: ${result.summaryCounts.findingsOpen}`);
  console.log(`Findings Resolved: ${result.summaryCounts.findingsResolved}`);

  if (isReportMode && result.runId) {
    console.log('\n=== RECONCILIATION FINDINGS REPORT ===');
    const { data: findings } = await (supabase as any)
      .from('billing_reconciliation_findings')
      .select('id, finding_category, severity, status, target_entity_type, target_entity_id, last_seen_at')
      .eq('status', 'open');

    if (!findings || findings.length === 0) {
      console.log('🎉 Clean Baseline Verified! ZERO open financial findings.');
    } else {
      console.table(findings);
    }
  }

  process.exit(result.status === 'failed' ? 1 : 0);
}

main().catch((err) => {
  console.error('CLI Fatal Exception:', err);
  process.exit(1);
});
