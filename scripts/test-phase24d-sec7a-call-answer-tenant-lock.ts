/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'fs';
import path from 'path';
import { normalizeE164PhoneNumber } from '../src/lib/utils';

// ============================================================================
// PHASE 24D.SEC-7A.1: REGRESSION LOCK & ADVERSARIAL TENANT SCOPE TEST
// Targeted Surface: src/app/api/calls/[callId]/answer/route.ts
// ============================================================================

console.log('======================================================================');
console.log('PHASE 24D.SEC-7A.1: CALL ANSWER HELPER TENANT SCOPE REGRESSION LOCK');
console.log('======================================================================\n');

let passedTests = 0;
let totalTests = 0;

function assert(description: string, condition: boolean, detail?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`[PASS] ${description}`);
  } else {
    console.error(`[FAIL] ${description}`);
    if (detail) console.error(`       Detail: ${detail}`);
  }
}

// ----------------------------------------------------------------------------
// PART 1: STATIC AST / SOURCE INTEGRITY REGRESSION LOCK
// Ensures future developers cannot remove the organization_id filter.
// ----------------------------------------------------------------------------
const routePath = path.resolve(process.cwd(), 'src/app/api/calls/[callId]/answer/route.ts');
const routeSource = fs.readFileSync(routePath, 'utf8');

// Extract tryAutoAssignUnsavedCaller function source
const helperMatch = routeSource.match(/async\s+function\s+tryAutoAssignUnsavedCaller[\s\S]*?^}/m);
assert('Helper Function Present', !!helperMatch, 'tryAutoAssignUnsavedCaller must be declared in route.ts');

if (helperMatch) {
  const helperCode = helperMatch[0];
  
  assert(
    'Helper Table Query Scoped to calls',
    helperCode.includes(".from('calls')"),
    "Helper must query the 'calls' table"
  );

  assert(
    'Helper Enforces callId Match',
    helperCode.includes(".eq('id', callId)"),
    "Helper must filter by .eq('id', callId)"
  );

  assert(
    'Helper Enforces organizationId Match (Defense-in-Depth)',
    helperCode.includes(".eq('organization_id', organizationId)"),
    "Helper must filter by .eq('organization_id', organizationId)"
  );

  assert(
    'Helper Uses .maybeSingle() For Safe Null Handling',
    helperCode.includes('.maybeSingle()'),
    'Helper must use .maybeSingle() to return null rather than throw on foreign/nonexistent calls'
  );
}

// ----------------------------------------------------------------------------
// PART 2: ADVERSARIAL MULTI-TENANT BEHAVIORAL SIMULATION
// Verifies that a service_role admin client cannot fetch or process
// foreign call data even if a foreign call ID is supplied to the helper.
// ----------------------------------------------------------------------------
const ORG_A = '11111111-1111-4111-8111-111111111111';
const AGENT_A = 'user_agent_a_1111';
const CALL_A = 'call_a_1111';
const CALL_A_FROM = '+12025550301';

const ORG_B = '22222222-2222-4222-8222-222222222222';
const AGENT_B = 'user_agent_b_2222';
const CALL_B = 'call_b_2222';
const CALL_B_FROM = '+12025550302';

interface MockCall {
  id: string;
  organization_id: string;
  from_number: string;
  direction: string;
  status: string;
}

const callsDb: MockCall[] = [
  {
    id: CALL_A,
    organization_id: ORG_A,
    from_number: CALL_A_FROM,
    direction: 'inbound',
    status: 'in-progress',
  },
  {
    id: CALL_B,
    organization_id: ORG_B,
    from_number: CALL_B_FROM,
    direction: 'inbound',
    status: 'in-progress',
  },
];

// Mock RPC invocation tracking
const rpcCalls: { fn: string; args: any }[] = [];

// Mock Service-Role Admin Supabase Client
function createMockAdminClient(store: MockCall[]) {
  return {
    from: (table: string) => {
      const filters: Record<string, any> = {};
      const builder: any = {
        select: (_cols: string) => builder,
        eq: (col: string, val: any) => {
          filters[col] = val;
          return builder;
        },
        maybeSingle: async () => {
          if (table !== 'calls') return { data: null, error: null };
          const row = store.find((item) => {
            return Object.entries(filters).every(([k, v]) => (item as any)[k] === v);
          });
          return { data: row || null, error: null };
        },
      };
      return builder;
    },
    rpc: async (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      return { data: true, error: null };
    },
  };
}

// Mirror of the remediated helper for runtime behavioral execution
async function runRemediatedHelper(
  adminSupabase: any,
  organizationId: string,
  callId: string,
  answeringAgentId: string
) {
  try {
    const { data: call } = await adminSupabase
      .from('calls')
      .select('from_number, direction')
      .eq('id', callId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!call || call.direction !== 'inbound' || !call.from_number) {
      return;
    }

    const { normalized } = normalizeE164PhoneNumber(call.from_number);
    const phoneNumber = normalized || call.from_number.trim();

    if (!phoneNumber) return;

    await adminSupabase.rpc('try_auto_assign_caller', {
      p_organization_id: organizationId,
      p_phone: phoneNumber,
      p_assigned_user_id: answeringAgentId,
    });
  } catch (err) {
    console.error('[Auto Assign Warning] Non-blocking auto caller assignment failed:', err);
  }
}

// ----------------------------------------------------------------------------
// Test Scenario 1: Legitimate Own-Org Call Processing
// ----------------------------------------------------------------------------
(async () => {
  rpcCalls.length = 0;
  const adminClient = createMockAdminClient(callsDb);

  await runRemediatedHelper(adminClient, ORG_A, CALL_A, AGENT_A);

  const ownCallAssigned = rpcCalls.find(
    (c) =>
      c.fn === 'try_auto_assign_caller' &&
      c.args.p_organization_id === ORG_A &&
      c.args.p_phone === CALL_A_FROM &&
      c.args.p_assigned_user_id === AGENT_A
  );

  assert(
    'Own Call Auto-Assignment Allowed',
    !!ownCallAssigned,
    'Legitimate call belonging to Org A must be auto-assigned to Agent A'
  );

  // ----------------------------------------------------------------------------
  // Test Scenario 2: Adversarial Foreign Call ID Substitution (IDOR / Cross-Org)
  // Org A actor supplies Call B (which belongs to Org B in calls table).
  // ----------------------------------------------------------------------------
  rpcCalls.length = 0;

  await runRemediatedHelper(adminClient, ORG_A, CALL_B, AGENT_A);

  const foreignCallBreached = rpcCalls.find(
    (c) =>
      c.fn === 'try_auto_assign_caller' &&
      (c.args.p_phone === CALL_B_FROM || c.args.p_organization_id === ORG_B)
  );

  assert(
    'Foreign Call Auto-Assignment Blocked (IDOR Denied)',
    !foreignCallBreached && rpcCalls.length === 0,
    'Supplying Org B call ID under Org A scope must yield null and never call try_auto_assign_caller'
  );

  // ----------------------------------------------------------------------------
  // Test Scenario 3: Enumeration Resistance (Foreign vs Nonexistent)
  // Ensure nonexistent call ID yields identical null behavior.
  // ----------------------------------------------------------------------------
  rpcCalls.length = 0;
  await runRemediatedHelper(adminClient, ORG_A, 'nonexistent_call_uuid', AGENT_A);

  assert(
    'Nonexistent Call Handled Identically (Enumeration Resistant)',
    rpcCalls.length === 0,
    'Nonexistent call must yield null with zero side effects, identical to foreign call'
  );

  // ----------------------------------------------------------------------------
  // Test Scenario 4: Counterfactual Vulnerability Test
  // Simulates what WOULD happen if .eq('organization_id', organizationId) were omitted.
  // Proves that the fix is what blocks the vulnerability.
  // ----------------------------------------------------------------------------
  async function runVulnerableHelper(adminSupabase: any, organizationId: string, callId: string, answeringAgentId: string) {
    const { data: call } = await adminSupabase
      .from('calls')
      .select('from_number, direction')
      .eq('id', callId) // Missing .eq('organization_id', organizationId)
      .maybeSingle();

    if (!call || call.direction !== 'inbound' || !call.from_number) return;

    const { normalized } = normalizeE164PhoneNumber(call.from_number);
    const phoneNumber = normalized || call.from_number.trim();
    if (!phoneNumber) return;

    await adminSupabase.rpc('try_auto_assign_caller', {
      p_organization_id: organizationId,
      p_phone: phoneNumber,
      p_assigned_user_id: answeringAgentId,
    });
  }

  rpcCalls.length = 0;
  await runVulnerableHelper(adminClient, ORG_A, CALL_B, AGENT_A);
  const vulnerableLeakOccurred = rpcCalls.some(
    (c) => c.fn === 'try_auto_assign_caller' && c.args.p_phone === CALL_B_FROM
  );

  assert(
    'Counterfactual Vulnerability Proved (Omission of Tenant Scope Leaks Foreign Data)',
    vulnerableLeakOccurred,
    'Without .eq("organization_id", organizationId), foreign caller data leaked across tenant boundaries'
  );

  // Summary
  console.log('\n======================================================================');
  console.log(`TOTAL REGRESSION LOCK TESTS: ${totalTests}`);
  console.log(`PASSED: ${passedTests}`);
  console.log(`FAILED: ${totalTests - passedTests}`);
  console.log('======================================================================');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
})();
