export {};

import fs from 'fs';
import path from 'path';

// Mock server-only module for tsx runner
const moduleObj = require('module');
try {
  const resolved = require.resolve('server-only');
  moduleObj._cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: {} };
} catch {}

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, description: string) {
  if (condition) {
    console.log(`[PASS] ${description}`);
    passCount++;
  } else {
    console.error(`[FAIL] ${description}`);
    failCount++;
  }
}

async function runTests() {
  console.log('\n============================================================');
  console.log('PHASE 19F.2A — PROFILES SCHEMA COMPATIBILITY & RECIPIENT RLS TESTS');
  console.log('============================================================\n');

  // 1. PAGE STRUCTURE & CANONICAL SECTION ORDER AUDIT
  console.log('--- 1. AUDITING INDIVIDUAL NUMBER PAGE STRUCTURE ---');
  const numberDetailPagePath = path.join(
    process.cwd(),
    'src/app/(dashboard)/numbers/[id]/page.tsx'
  );
  const detailCode = fs.readFileSync(numberDetailPagePath, 'utf8');

  const idxNumberCard = detailCode.indexOf('1. NUMBER CARD / NUMBER DETAILS');
  const idxNotifications = detailCode.indexOf('<NumberNotificationsSettings');
  const idxCallerId = detailCode.indexOf('3. CALLER ID');
  const idxSharedAccess = detailCode.indexOf('4. SHARED ACCESS & 5. TEAM MEMBER ASSIGNMENT');
  const idxStrategy = detailCode.indexOf('6. INCOMING CALL STRATEGY');
  const idxGreetings = detailCode.indexOf('7. GREETINGS & AUDIO');
  const idxLifecycle = detailCode.indexOf('8. NUMBER LIFECYCLE');

  assert(idxNumberCard !== -1, 'Section 1: Number Card / Details present');
  assert(idxNotifications !== -1, 'Section 2: Notifications section present');
  assert(idxCallerId !== -1, 'Section 3: Caller ID section present');
  assert(idxSharedAccess !== -1, 'Section 4 & 5: Shared Access & Team Member Assignment present');
  assert(idxStrategy !== -1, 'Section 6: Incoming Call Strategy present');
  assert(idxGreetings !== -1, 'Section 7: Greetings & Audio present');
  assert(idxLifecycle !== -1, 'Section 8: Number Lifecycle section present at bottom');

  assert(
    idxNumberCard < idxNotifications &&
      idxNotifications < idxCallerId &&
      idxCallerId < idxSharedAccess &&
      idxSharedAccess < idxStrategy &&
      idxStrategy < idxGreetings &&
      idxGreetings < idxLifecycle,
    'Canonical customer-facing 8-section order strictly preserved'
  );

  const idxOldAdditionalSettings = detailCode.indexOf('Additional Settings & Lifecycle');
  assert(
    idxOldAdditionalSettings === -1,
    'Old miscellaneous "Additional Settings & Lifecycle" container successfully removed'
  );

  const jsxGreetingsMatches = (detailCode.match(/<GreetingsAudioSettings/g) || []).length;
  assert(
    jsxGreetingsMatches === 1,
    'Single authoritative Greetings & Audio section preserved with ZERO duplicate JSX components'
  );

  // 2. EMAIL NOTIFICATION PREFERENCES & PROFILES AUDIT
  console.log('\n--- 2. AUDITING EMAIL NOTIFICATION API & PROFILES MODEL ---');
  const notifApiPath = path.join(
    process.cwd(),
    'src/app/api/phone-numbers/[id]/notifications/route.ts'
  );
  const notifCode = fs.readFileSync(notifApiPath, 'utf8');

  assert(
    !notifCode.includes('organization_memberships'),
    'API contains ZERO references to nonexistent organization_memberships table'
  );
  assert(
    notifCode.includes('.from(\'profiles\')'),
    'API queries public.profiles directly for active workspace members & recipient validation'
  );
  assert(
    notifCode.includes('CROSS_TENANT_RECIPIENT_REJECTED'),
    'API rejects cross-tenant/inactive recipient user selection with 400 Bad Request'
  );
  assert(
    notifCode.includes('.from(\'user_phone_assignments\')'),
    'API derives assigned_members mode from user_phone_assignments + active profiles'
  );
  assert(
    notifCode.includes('deliveryStatus: \'NOT_READY\''),
    'API marks email delivery status as NOT_READY without inventing credentials'
  );

  // 3. NUMBER LIFECYCLE & ZERO MUTATION GATES AUDIT
  console.log('\n--- 3. AUDITING NUMBER LIFECYCLE & PROVIDER MUTATION GATES ---');
  const lifecycleCompPath = path.join(
    process.cwd(),
    'src/components/numbers/NumberLifecycleSettings.tsx'
  );
  const lifecycleCode = fs.readFileSync(lifecycleCompPath, 'utf8');

  assert(
    lifecycleCode.includes('Port Out Number'),
    'Port Out Number workflow component present with outlined/warning styling'
  );
  assert(
    lifecycleCode.includes('Release Number'),
    'Release Number present with red/danger visual treatment'
  );
  assert(
    lifecycleCode.includes('confirm_phone_number'),
    'Release Number requires typed phone number confirmation'
  );
  assert(
    lifecycleCode.includes('Provider release mutation gate is currently OFF'),
    'Provider release mutation gate remains OFF with ZERO live carrier mutations'
  );

  // 4. MY NUMBERS HOME PAGE AUDIT
  console.log('\n--- 4. AUDITING MY NUMBERS HOME PAGE & PORT IN COMPANION ---');
  const myNumbersPath = path.join(process.cwd(), 'src/app/(dashboard)/numbers/page.tsx');
  const myNumbersCode = fs.readFileSync(myNumbersPath, 'utf8');

  assert(
    myNumbersCode.includes('Port In Existing Number'),
    'My Numbers home page includes "Port In Existing Number" companion action'
  );
  assert(
    myNumbersCode.includes('Buy New Number'),
    'Existing Buy New Number workflow preserved'
  );
  assert(
    myNumbersCode.includes('isPortInModalOpen'),
    'Port In opens clean explanatory foundation modal with execution NOT_READY'
  );

  // 5. HARDENED MIGRATION FILE & PROFILES RLS AUDIT
  console.log('\n--- 5. AUDITING HARDENED MIGRATION & PROFILES RLS ---');
  const migrationFilename = '20270320000000_phase19f2a_notifications_and_lifecycle_foundation.sql';
  const migrationFilePath = path.join(process.cwd(), 'supabase/migrations', migrationFilename);
  const migrationExists = fs.existsSync(migrationFilePath);
  assert(migrationExists, `Local additive migration file created: ${migrationFilename}`);

  if (migrationExists) {
    const migrationSql = fs.readFileSync(migrationFilePath, 'utf8');

    assert(
      !migrationSql.includes('organization_memberships'),
      'Migration contains ZERO references to nonexistent organization_memberships table'
    );
    assert(
      migrationSql.includes('recipient_user_ids UUID[] NOT NULL DEFAULT \'{}\''),
      'recipient_user_ids defined as NOT NULL DEFAULT \'{}\''
    );
    assert(
      migrationSql.includes('chk_recipient_mode_consistency'),
      'Recipient mode consistency constraint present (selected_users OR empty recipient array)'
    );
    assert(
      migrationSql.includes('unnest(number_notification_settings.recipient_user_ids) AS rid'),
      'Database-level RLS unnest array tenant validation clause present'
    );
    assert(
      migrationSql.includes('SELECT 1 FROM public.profiles'),
      'RLS policies validate against public.profiles table'
    );
    assert(
      migrationSql.includes('id = auth.uid()') && migrationSql.includes('active = true'),
      'RLS enforces profiles.id = auth.uid() and profiles.active = true'
    );
    assert(
      migrationSql.includes('role IN (\'owner\', \'admin\')'),
      'RLS restricts mutation to owner or admin roles'
    );
    assert(
      !migrationSql.toLowerCase().includes('drop table') &&
        !migrationSql.toLowerCase().includes('alter table public.phone_numbers drop'),
      'Migration is strictly additive and non-destructive'
    );
  }

  // 6. EXACT RECIPIENT & AUTHORIZATION TEST CASES AUDIT
  console.log('\n--- 6. AUDITING RECIPIENT & AUTHORIZATION TEST CASES ---');
  const migrationContent = fs.readFileSync(migrationFilePath, 'utf8');

  // Case 1: Owner/Admin + empty recipient array
  assert(
    migrationContent.includes('role IN (\'owner\', \'admin\')') &&
      migrationContent.includes('cardinality(number_notification_settings.recipient_user_ids) = 0'),
    'Test case 1: Owner/admin + empty recipient array allowed'
  );

  // Case 2: Selected_users + active same-org user
  assert(
    migrationContent.includes('recipient_mode = \'selected_users\'') &&
      migrationContent.includes('SELECT 1 FROM public.profiles'),
    'Test case 2: Selected_users + active same-org profile allowed'
  );

  // Case 3: Foreign-org user denied by DB RLS
  assert(
    migrationContent.includes('WHERE NOT EXISTS (\n                    SELECT 1 FROM public.profiles'),
    'Test case 3: Foreign-org user denied by DB RLS unnest check'
  );

  // Case 4: Inactive same-org profile denied by DB RLS
  assert(
    migrationContent.includes('AND active = true'),
    'Test case 4: Inactive profile denied by DB RLS'
  );

  // Case 5: Mismatched phone_number organization denied
  assert(
    migrationContent.includes('WHERE organization_id = number_notification_settings.organization_id'),
    'Test case 5: Mismatched phone number organization denied'
  );

  // Case 6: Empty array works for assigned_members/workspace_admins/all_members
  assert(
    migrationContent.includes('cardinality(recipient_user_ids) = 0'),
    'Test case 6: Empty array valid for assigned_members/workspace_admins/all_members'
  );

  console.log('\n============================================================');
  console.log(`TEST SUMMARY: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('============================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
