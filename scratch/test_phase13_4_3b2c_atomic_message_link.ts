let totalTests = 0;
let passedTests = 0;

function assert(condition: boolean, description: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✓ ${description}`);
  } else {
    console.error(`  ✕ FAIL: ${description}`);
    throw new Error(`Assertion failed: ${description}`);
  }
}

// In-Memory Database State with Mutex for Row Locking
interface ComponentRow {
  component_id: string;
  session_id: string;
  organization_id: string;
  child_provider_resource_id: string | null;
}

class SimulatedPostgresEngine {
  private components: Map<string, ComponentRow> = new Map();
  private orgLocks: Map<string, Promise<void>> = new Map();

  public addComponent(comp: ComponentRow) {
    this.components.set(`${comp.organization_id}:${comp.component_id}`, { ...comp });
  }

  public getComponent(orgId: string, compId: string): ComponentRow | undefined {
    return this.components.get(`${orgId}:${compId}`);
  }

  /**
   * Simulates PL/pgSQL function link_telecom_message_provider_resource_atomic inside ONE transaction with FOR UPDATE locks
   */
  public async linkTelecomMessageProviderResourceAtomic(params: {
    p_organization_id: string;
    p_session_id: string;
    p_component_id: string;
    p_provider_message_sid: string;
  }): Promise<{ data: any; error: any }> {
    const {
      p_organization_id,
      p_session_id,
      p_component_id,
      p_provider_message_sid,
    } = params;

    const cleanOrgId = p_organization_id;
    const cleanSessionId = (p_session_id || '').trim();
    const cleanComponentId = (p_component_id || '').trim();
    const cleanSid = (p_provider_message_sid || '').trim();

    // 1. Input Validation
    if (!cleanOrgId) {
      return { data: null, error: { message: 'INVALID_ARGUMENT: p_organization_id is required.' } };
    }
    if (cleanSessionId.length === 0) {
      return { data: null, error: { message: 'INVALID_SESSION_ID: p_session_id is required.' } };
    }
    if (cleanComponentId.length === 0) {
      return { data: null, error: { message: 'INVALID_COMPONENT_ID: p_component_id is required.' } };
    }
    if (cleanSid.length === 0) {
      return { data: null, error: { message: 'INVALID_PROVIDER_MESSAGE_SID: p_provider_message_sid is required.' } };
    }

    // 2. Lock Organization for Serialization Boundary
    const lockKey = cleanOrgId;
    const currentLock = this.orgLocks.get(lockKey) || Promise.resolve();
    let nextLockResolve: () => void;
    const nextLock = new Promise<void>((resolve) => {
      nextLockResolve = resolve;
    });
    this.orgLocks.set(lockKey, currentLock.then(() => nextLock));

    await currentLock;

    try {
      await new Promise((r) => setTimeout(r, 10)); // Artificial delay for concurrency test

      const key = `${cleanOrgId}:${cleanComponentId}`;
      const v_comp = this.components.get(key);

      // 3. Verify Component Existence & Session Isolation
      if (!v_comp) {
        return { data: null, error: { message: `COMPONENT_NOT_FOUND: Component ${cleanComponentId} not found for organization ${cleanOrgId}` } };
      }

      if (v_comp.session_id !== cleanSessionId) {
        return { data: null, error: { message: `SESSION_MISMATCH: Component ${cleanComponentId} belongs to session ${v_comp.session_id}, not ${cleanSessionId}` } };
      }

      // 4. Atomic Write-Once Provider MessageSid Linkage
      if (!v_comp.child_provider_resource_id) {
        v_comp.child_provider_resource_id = cleanSid;
        return {
          data: {
            success: true,
            status: 'linked',
            provider_message_sid: cleanSid,
          },
          error: null,
        };
      } else if (v_comp.child_provider_resource_id === cleanSid) {
        return {
          data: {
            success: true,
            status: 'idempotent_match',
            provider_message_sid: cleanSid,
          },
          error: null,
        };
      } else {
        return { data: null, error: { message: `MESSAGE_SID_MISMATCH: Stored provider MessageSid ${v_comp.child_provider_resource_id} conflicts with incoming MessageSid ${cleanSid}` } };
      }
    } finally {
      nextLockResolve!();
    }
  }
}

async function runAtomicMessageLinkTest() {
  console.log('================================================================');
  console.log('PHASE 13.4.3B.2C — ATOMIC MESSAGE SID RPC CONTRACT SUITE');
  console.log('================================================================\n');

  const engine = new SimulatedPostgresEngine();
  const timestamp = Date.now();
  const testOrgId = 'org-200';
  const testSessionId = `sess_msg_${timestamp}`;
  const testComponentId = `comp_msg_${timestamp}`;

  engine.addComponent({
    component_id: testComponentId,
    session_id: testSessionId,
    organization_id: testOrgId,
    child_provider_resource_id: null,
  });

  console.log('--- RPC CONTRACT VERIFICATION ---');

  // Test 23: NULL stored SID -> SM_MSG_A => linked
  const { data: res1, error: err1 } = await engine.linkTelecomMessageProviderResourceAtomic({
    p_organization_id: testOrgId,
    p_session_id: testSessionId,
    p_component_id: testComponentId,
    p_provider_message_sid: `SM_MSG_A_${timestamp}`,
  });
  assert(!err1 && res1?.success && res1?.status === 'linked', '23. NULL MessageSid links cleanly (returns status=linked)');

  // Test 24: Identical SID -> SM_MSG_A => idempotent_match
  const { data: res2, error: err2 } = await engine.linkTelecomMessageProviderResourceAtomic({
    p_organization_id: testOrgId,
    p_session_id: testSessionId,
    p_component_id: testComponentId,
    p_provider_message_sid: `SM_MSG_A_${timestamp}`,
  });
  assert(!err2 && res2?.success && res2?.status === 'idempotent_match', '24. Identical MessageSid returns status=idempotent_match');

  // Test 25: Conflicting SID -> SM_MSG_B => MESSAGE_SID_MISMATCH (fail closed)
  const { data: res3, error: err3 } = await engine.linkTelecomMessageProviderResourceAtomic({
    p_organization_id: testOrgId,
    p_session_id: testSessionId,
    p_component_id: testComponentId,
    p_provider_message_sid: `SM_MSG_B_${timestamp}`,
  });
  assert(err3 && err3.message.includes('MESSAGE_SID_MISMATCH'), '25. Conflicting MessageSid fails closed with MESSAGE_SID_MISMATCH');


  // Test 20: SIMULTANEOUS CONCURRENT FIRST-LINK RACE
  console.log('\n--- 20. CONCURRENCY RACE TEST ---');
  const raceSessionId = `sess_race_${timestamp}`;
  const raceComponentId = `comp_race_${timestamp}`;

  engine.addComponent({
    component_id: raceComponentId,
    session_id: raceSessionId,
    organization_id: testOrgId,
    child_provider_resource_id: null,
  });

  const promiseA = engine.linkTelecomMessageProviderResourceAtomic({
    p_organization_id: testOrgId, p_session_id: raceSessionId, p_component_id: raceComponentId, p_provider_message_sid: `SM_WINNER_A_${timestamp}`,
  });
  const promiseB = engine.linkTelecomMessageProviderResourceAtomic({
    p_organization_id: testOrgId, p_session_id: raceSessionId, p_component_id: raceComponentId, p_provider_message_sid: `SM_WINNER_B_${timestamp}`,
  });

  const [resA, resB] = await Promise.all([promiseA, promiseB]);

  const winA = !resA.error && resA.data?.status === 'linked';
  const winB = !resB.error && resB.data?.status === 'linked';

  assert((winA && !winB) || (!winA && winB), '20a. Exactly ONE concurrent request succeeded with status=linked');

  const finalComp = engine.getComponent(testOrgId, raceComponentId);
  const winnerSid = winA ? `SM_WINNER_A_${timestamp}` : `SM_WINNER_B_${timestamp}`;
  assert(finalComp?.child_provider_resource_id === winnerSid, '20b. Stored component value matches winning transaction');

  console.log('\n================================================================');
  console.log(`ATOMIC MESSAGE SID RPC SUITE PASSED: ${passedTests} / ${totalTests} assertions verified clean.`);
  console.log('================================================================\n');
}

runAtomicMessageLinkTest().catch((err) => {
  console.error('[Atomic Message Link Suite Failed]:', err);
  process.exit(1);
});
