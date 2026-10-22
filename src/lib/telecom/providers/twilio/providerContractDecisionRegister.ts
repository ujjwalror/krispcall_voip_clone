/**
 * ==============================================================================
 * PHASE 23F.2C: TWILIO PROVIDER CONTRACT DECISION REGISTER
 * ==============================================================================
 *
 * Machine-readable architectural decision register capturing current Twilio
 * provider contracts, IAM boundaries, subaccount lifecycles, regulatory rules,
 * messaging/voice constraints, and competitor industry standards as of 2026-10-20.
 *
 * GOVERNANCE:
 * - NO CREDENTIALS MAY BE STORED IN THIS FILE.
 * - This file represents architectural decisions and provider contracts, not
 *   runtime configuration.
 * - Unknown provider behaviors are classified as CONTROLLED_LIVE_VALIDATION_REQUIRED
 *   or DOCUMENTATION_AMBIGUOUS rather than assumed.
 * - Provider behavior that changes frequently must be re-validated per the
 *   Research Freshness Policy.
 */

export type ProviderContractEvidenceClassification =
  | 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS'
  | 'LIVE_OPERATOR_CONSOLE_EVIDENCE'
  | 'CONFIRMED_CURRENT_COMPETITOR_PRODUCT_EVIDENCE'
  | 'LOCAL_CODE_EVIDENCE'
  | 'CONTROLLED_LIVE_VALIDATION_REQUIRED'
  | 'DOCUMENTATION_AMBIGUOUS'
  | 'BUSINESS_POLICY_DECISION_REQUIRED'
  | 'FUTURE_PROVIDER_RESEARCH_REQUIRED';

export type ProviderContractDomain =
  | 'ACCOUNT_AND_SUBACCOUNT'
  | 'IAM_AND_CREDENTIALS'
  | 'NUMBER_DISCOVERY'
  | 'NUMBER_PURCHASE_AND_PROVISIONING'
  | 'REGULATORY_COMPLIANCE'
  | 'MESSAGING_AND_A2P'
  | 'VOICE_AND_FRAUD_CONTROLS'
  | 'SMS_GEO_AND_PUMPING'
  | 'NUMBER_PORT_IN'
  | 'NUMBER_PORT_OUT'
  | 'NUMBER_RELEASE'
  | 'PRICING_AND_BILLING'
  | 'WEBHOOK_AND_SIGNING';

export interface ProviderContractDecision {
  decisionId: string;
  domain: ProviderContractDomain;
  statement: string;
  classification: ProviderContractEvidenceClassification;
  source: string;
  researchedAt: string; // ISO date '2026-10-20'
  requiresLiveValidation: boolean;
  supersedes?: string[];
  notes?: string;
}

export const TWILIO_PROVIDER_CONTRACT_DECISION_REGISTER: Record<
  string,
  ProviderContractDecision
> = {
  // ----------------------------------------------------------------------------
  // DOMAIN: ACCOUNT_AND_SUBACCOUNT
  // ----------------------------------------------------------------------------
  'DEC-ACC-001': {
    decisionId: 'DEC-ACC-001',
    domain: 'ACCOUNT_AND_SUBACCOUNT',
    statement:
      'Subaccount creation requires elevated root-equivalent account authority (Parent Main API Key or AccountSid/AuthToken). Twilio Restricted API keys cannot be permissioned for subaccount creation.',
    classification: 'LIVE_OPERATOR_CONSOLE_EVIDENCE',
    source:
      'Twilio US1 Console -> API keys & auth tokens -> Create API key -> Restricted -> IAM permissions (accounts: Create UNAVAILABLE)',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    supersedes: ['PRE_23F2B_ASSUMPTION_RESTRICTED_KEY_CAN_CREATE_SUBACCOUNT'],
    notes:
      'Confirmed by direct operator inspection on 2026-10-20. Subaccount creation must use PARENT_ACCOUNT_ADMIN_HIGH_PRIVILEGE.',
  },
  'DEC-ACC-002': {
    decisionId: 'DEC-ACC-002',
    domain: 'ACCOUNT_AND_SUBACCOUNT',
    statement:
      'Subaccounts do not possess independent billing or credit cards. All child subaccount charges roll up directly to the parent account invoice and balance.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio Official Docs: Understanding Subaccounts & Billing Hierarchy',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'Parent account balance must be maintained to prevent platform-wide suspension.',
  },
  'DEC-ACC-003': {
    decisionId: 'DEC-ACC-003',
    domain: 'ACCOUNT_AND_SUBACCOUNT',
    statement:
      'Default subaccount limit is 1,000 active subaccounts per parent account. Increases beyond 1,000 require contacting Twilio Sales/Support.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio Official Docs: Subaccount Limits and Best Practices',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'Scale planning must track active subaccounts against the 1,000 threshold.',
  },
  'DEC-ACC-004': {
    decisionId: 'DEC-ACC-004',
    domain: 'ACCOUNT_AND_SUBACCOUNT',
    statement:
      'Closing a subaccount (POST /Accounts/{sid}.json Status=closed) is permanent and IRREVERSIBLE. All owned phone numbers are immediately released, active calls/sessions terminate, and the subaccount cannot be reactivated.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio REST API Reference: Accounts Resource - Closing a Subaccount',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'Subaccount closure releases carrier phone numbers immediately; canonical status becomes SUBACCOUNT_CLOSED.',
  },
  'DEC-ACC-005': {
    decisionId: 'DEC-ACC-005',
    domain: 'ACCOUNT_AND_SUBACCOUNT',
    statement:
      'Subaccount closure is distinct from provider data purge. Under Twilio closed-subaccount deletion settings, closed subaccounts enter a 30-day retention window (PROVIDER_RETENTION_PENDING) before physical deletion (PROVIDER_PURGED). Canonical VoIP Hub history and CDR audit logs survive provider purge permanently.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio Official Docs: Closed Subaccount Deletion & Data Retention Settings',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'VoIP Hub canonical database retains complete organizational audit records independently of provider-side deletion.',
  },
  'DEC-ACC-006': {
    decisionId: 'DEC-ACC-006',
    domain: 'ACCOUNT_AND_SUBACCOUNT',
    statement:
      'Subaccounts strictly isolate Phone Numbers, Messages, Calls, Recordings, Transcriptions, API Keys, and TwiML Apps. They do NOT isolate parent account balance, Voice/SMS Geo Permissions (inherited by default), or Trust Hub primary profile.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio Official Docs: Subaccount Resource Isolation Guarantees',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'Resource isolation is strong at the data tier, but parent governance controls billing and geo-filtering.',
  },
  'DEC-ACC-007': {
    decisionId: 'DEC-ACC-007',
    domain: 'ACCOUNT_AND_SUBACCOUNT',
    statement:
      'Parent Main API Key may fetch the child Account resource (GET /2010-04-01/Accounts/{SubaccountSid}.json) through the parent Accounts API, and the returned Account resource representation includes the child auth_token. This corrects the Phase 23F.3B-PRE conclusion that child Auth Token cannot be retrieved later. However, this does NOT authorize using the Parent Main API Key for ordinary resources inside the child account (Calls, Messages, PhoneNumbers, or child-owned API keys).',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source:
      'Twilio REST API Reference: Accounts Resource (GET /2010-04-01/Accounts/{Sid}.json) & Subaccounts API Key Documentation',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    supersedes: ['PRE_23F3B_PRE_ASSUMPTION_CHILD_AUTH_TOKEN_NOT_RETRIEVABLE_LATER'],
    notes:
      'Verified against official Twilio documentation and Node.js SDK example. The Parent Accounts API permits fetching child Account representations including auth_token, while ordinary subaccount resource CRUD remains strictly segregated.',
  },

  // ----------------------------------------------------------------------------
  // DOMAIN: IAM_AND_CREDENTIALS
  // ----------------------------------------------------------------------------
  'DEC-IAM-001': {
    decisionId: 'DEC-IAM-001',
    domain: 'IAM_AND_CREDENTIALS',
    statement:
      'The canonical, minimum-privilege mechanism to bootstrap a child subaccount runtime API key is to use the newly created subaccount SID and its initial Auth Token ephemerally via POST /Accounts/{ChildSid}/Keys.json.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio REST API Reference: Keys Resource & Subaccount Authentication',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'Method A (SUBACCOUNT_EPHEMERAL_AUTH_TOKEN) requires zero parent administrative credentials during key generation.',
  },
  'DEC-IAM-002': {
    decisionId: 'DEC-IAM-002',
    domain: 'IAM_AND_CREDENTIALS',
    statement:
      'Parent Main API Keys (PARENT_MAIN_API_KEY) and Parent Account SID + Auth Token (PARENT_ACCOUNT_SID_AUTH_TOKEN) are NOT universally scope-equivalent. Twilio subaccounts documentation explicitly warns: "Main account API Keys are only available to access main account resources. Access to subaccount resources will be denied." Conversely, parent Account SID + Auth Token can access child v2010 REST resources. Child telecom CRUD must strictly use CHILD_RUNTIME_API_KEY.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio Subaccounts Documentation: API Keys & Subaccount Access Nuances',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    supersedes: ['PRE_23F2C_COLLAPSED_PARENT_ADMIN_CREDENTIAL_MODEL'],
    notes:
      'Distinct credential classes must be modeled. Parent credentials must never become generic customer runtime.',
  },
  'DEC-IAM-003': {
    decisionId: 'DEC-IAM-003',
    domain: 'IAM_AND_CREDENTIALS',
    statement:
      'Whether a parent Restricted API key with IAM/api-keys permissions can create or manage keys on child subaccounts without child auth token credentials is not officially confirmed and requires empirical validation.',
    classification: 'CONTROLLED_LIVE_VALIDATION_REQUIRED',
    source: 'Twilio IAM Documentation: Cross-account Restricted API Key scoping',
    researchedAt: '2026-10-20',
    requiresLiveValidation: true,
    notes:
      'Flag PROVIDER_ACCOUNT_SCOPE_REQUIRES_CONTROLLED_VALIDATION remains active.',
  },
  'DEC-IAM-004': {
    decisionId: 'DEC-IAM-004',
    domain: 'IAM_AND_CREDENTIALS',
    statement:
      'Twilio Standard API keys receive Error 70004 (401 Unauthorized) when querying Account management endpoints. This is positive empirical proof of least-privilege boundary enforcement.',
    classification: 'LIVE_OPERATOR_CONSOLE_EVIDENCE',
    source: 'Phase 23F.2 V0 Empirical Provider Log (Error 70004)',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'Standard keys must remain confined to standard telecom resources (Voice, SMS, Numbers).',
  },
  'DEC-IAM-005': {
    decisionId: 'DEC-IAM-005',
    domain: 'IAM_AND_CREDENTIALS',
    statement:
      'Twilio API Key secrets are returned only once at creation time and cannot subsequently be fetched. V3 child key bootstrap must transactionally capture the SID and secret in memory, immediately store them in TelecomSecretVault, and verify durable encrypted persistence. If vault persistence fails, the system MUST NOT blindly create another key; it must mark the operation as ambiguous and initiate orphan-key reconciliation.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio REST API Reference: Keys Resource & Key Secret Lifecycle',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'Prevents orphan credential proliferation in provider environment on local storage failure.',
  },
  'DEC-IAM-006': {
    decisionId: 'DEC-IAM-006',
    domain: 'IAM_AND_CREDENTIALS',
    statement:
      'Canonical credential scope hierarchy strictly separates three boundaries: (1) PARENT MAIN API KEY -> PARENT ACCOUNTS API -> Create/fetch/manage child Account resources; (2) CHILD ACCOUNT SID + CHILD AUTH TOKEN -> CHILD RESOURCE AUTHENTICATION -> Ephemerally bootstrap child runtime API key; (3) CHILD RUNTIME API KEY -> SUPPORTED CUSTOMER TELECOM RUNTIME CRUD. Parent Main API Key is never a customer runtime credential, and ZERO PARENT FALLBACK remains mandatory.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source:
      'Twilio IAM Documentation: API Keys and Subaccount Access & Least-Privilege Architecture Freeze',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'Twilio API Key secrets generated at V3 are returned only once upon POST /Accounts/{ChildSid}/Keys.json and can never be re-fetched. Therefore, V3 runtime API key secret storage strictly requires active KMS envelope encryption in TelecomSecretVault.',
  },

  // ----------------------------------------------------------------------------
  // DOMAIN: NUMBER_DISCOVERY
  // ----------------------------------------------------------------------------
  'DEC-NUM-001': {
    decisionId: 'DEC-NUM-001',
    domain: 'NUMBER_DISCOVERY',
    statement:
      'AvailablePhoneNumbers search (GET /2010-04-01/Accounts/{AccountSid}/AvailablePhoneNumbers/{CountryCode}/{Type}.json) can be performed directly using customer subaccount credentials without exposing parent credentials.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio REST API Reference: AvailablePhoneNumbers Resource',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'Search results reflect public carrier inventory available across all accounts.',
  },
  'DEC-NUM-002': {
    decisionId: 'DEC-NUM-002',
    domain: 'NUMBER_DISCOVERY',
    statement:
      'Carrier number search inventory is volatile and ephemeral. Twilio does not support reservation locks on available phone numbers prior to purchase.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio Phone Numbers FAQ & API Guidance: Inventory Availability',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'Price quotes and inventory snapshots must be validated immediately prior to purchase.',
  },
  'DEC-NUM-003': {
    decisionId: 'DEC-NUM-003',
    domain: 'NUMBER_DISCOVERY',
    statement:
      'AvailablePhoneNumbers reports capabilities (voice, SMS, MMS, fax) and address_requirements (none, any, local, foreign). Some international numbers also return required regulatory bundle requirements.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio REST API Reference: AvailablePhoneNumbers Properties',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'VoIP Hub UI must pre-check regulatory and address requirements during customer browsing.',
  },

  // ----------------------------------------------------------------------------
  // DOMAIN: NUMBER_PURCHASE_AND_PROVISIONING
  // ----------------------------------------------------------------------------
  'DEC-PUR-001': {
    decisionId: 'DEC-PUR-001',
    domain: 'NUMBER_PURCHASE_AND_PROVISIONING',
    statement:
      'Twilio IncomingPhoneNumbers API (POST /2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers.json) does NOT accept a client-specified Idempotency-Key header.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio REST API Reference: IncomingPhoneNumbers Resource (No idempotency header)',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'Network timeouts or 5xx responses during purchase require immediate reconciliation by querying existing numbers in the subaccount before retrying.',
  },
  'DEC-PUR-002': {
    decisionId: 'DEC-PUR-002',
    domain: 'NUMBER_PURCHASE_AND_PROVISIONING',
    statement:
      'Purchasing a number under /Accounts/{ChildSid}/IncomingPhoneNumbers.json binds that phone number strictly to the customer subaccount. It is never owned by the parent account.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio Phone Numbers Documentation: Multi-tenant Number Ownership',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'Matches VoIP Hub canonical requirement: zero parent-owned customer phone numbers.',
  },
  'DEC-PUR-003': {
    decisionId: 'DEC-PUR-003',
    domain: 'NUMBER_PURCHASE_AND_PROVISIONING',
    statement:
      'Purchasing a number requiring regulatory approval without a valid, approved BundleSid fails with Error 21631. Purchasing without required address fails with Error 21649.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio Error Code Directory: 21631 & 21649',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'Phase 23D.7B regulatory pre-check prevents dispatching purchases without prerequisite bundles.',
  },

  // ----------------------------------------------------------------------------
  // DOMAIN: REGULATORY_COMPLIANCE
  // ----------------------------------------------------------------------------
  'DEC-REG-001': {
    decisionId: 'DEC-REG-001',
    domain: 'REGULATORY_COMPLIANCE',
    statement:
      'Twilio Trust Hub Regulatory Compliance API organizes compliance into Regulations (RN...), Bundles (BU...), EndUsers (IT...), SupportingDocuments (RD...), and Addresses (AD...). Bundles progress through draft -> pending-review -> in-review -> twilio-approved | twilio-rejected.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio Trust Hub Documentation: Regulatory Compliance API Guide',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'Twilio-specific IDs must be encapsulated behind canonical ComplianceCase domain models.',
  },
  'DEC-REG-002': {
    decisionId: 'DEC-REG-002',
    domain: 'REGULATORY_COMPLIANCE',
    statement:
      'Mature SaaS competitors (KrispCall, JustCall, Aircall, Dialpad) shield users from raw carrier regulatory IDs, presenting a guided 4-step wizard: What is required -> Document collection -> Review status tracker -> Rejection remediation.',
    classification: 'CONFIRMED_CURRENT_COMPETITOR_PRODUCT_EVIDENCE',
    source:
      'Competitor Product Audit: KrispCall / JustCall / Aircall Number Compliance Flows',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'VoIP Hub customer experience must match this guided workflow without leaking Twilio Trust Hub terminology.',
  },

  // ----------------------------------------------------------------------------
  // DOMAIN: MESSAGING_AND_A2P
  // ----------------------------------------------------------------------------
  'DEC-MSG-001': {
    decisionId: 'DEC-MSG-001',
    domain: 'MESSAGING_AND_A2P',
    statement:
      'Twilio ISV Architecture Type #1 specifies: one customer ➔ one customer-mapped subaccount ➔ Messaging Services inside that customer account corresponding to messaging use cases ➔ Secondary Customer Profile ➔ Brand ➔ Campaign(s). A customer may have multiple messaging use cases/campaigns and each use case may map to its own dedicated Messaging Service. The architecture is NOT limited to exactly one Messaging Service per customer.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio Documentation: A2P 10DLC Onboarding Guide for ISVs (Architecture Type #1)',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'VoIP Hub 1:1 organization-to-subaccount architecture fulfills Twilio Type #1 recommendations and supports multi-service scaling.',
  },
  'DEC-MSG-002': {
    decisionId: 'DEC-MSG-002',
    domain: 'MESSAGING_AND_A2P',
    statement:
      'A2P 10DLC requires registration of Brands (Standard or Sole Proprietor) and Campaigns. Campaign registration incurs carrier vetting fees and recurring monthly campaign fees.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio Pricing & A2P Documentation: Carrier Campaign Fees',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'Campaign registration costs must be factored into commercial tenant billing.',
  },
  'DEC-MSG-003': {
    decisionId: 'DEC-MSG-003',
    domain: 'MESSAGING_AND_A2P',
    statement:
      'US/Canada Toll-Free numbers require Toll-Free Verification (TFV) prior to sending high-volume SMS. Unverified toll-free SMS is subject to heavy carrier blocking and surcharges.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio Toll-Free Message Verification Documentation',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'VoIP Hub must support TFV submission workflows for toll-free number purchases.',
  },

  // ----------------------------------------------------------------------------
  // DOMAIN: VOICE_AND_FRAUD_CONTROLS
  // ----------------------------------------------------------------------------
  'DEC-VOI-001': {
    decisionId: 'DEC-VOI-001',
    domain: 'VOICE_AND_FRAUD_CONTROLS',
    statement:
      'Voice Dialing Geographic Permissions default to inherited from the parent account. High-risk international destinations must be blocked globally at the parent account level to prevent toll fraud.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio Voice Security Documentation: Dialing Geographic Permissions',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'Flag PARENT_TWILIO_ACCOUNT_PROTECTION_RESEARCH_MANDATORY remains active.',
  },
  'DEC-VOI-002': {
    decisionId: 'DEC-VOI-002',
    domain: 'VOICE_AND_FRAUD_CONTROLS',
    statement:
      'Twilio default Voice call dispatch limit is 1 Call Per Second (CPS) per subaccount. Higher CPS requires purchasing additional CPS capacity.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio Programmable Voice Limits & Throughput Documentation',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'Customer outbound dialers must queue calls to prevent provider-side 429 rate-limiting.',
  },

  // ----------------------------------------------------------------------------
  // DOMAIN: SMS_GEO_AND_PUMPING
  // ----------------------------------------------------------------------------
  'DEC-SPU-001': {
    decisionId: 'DEC-SPU-001',
    domain: 'SMS_GEO_AND_PUMPING',
    statement:
      'SMS Geographic Permissions and SMS Pumping Protection (Fraud Guard) are configured at the parent account level and apply to subaccounts. Certain settings can only be altered in Twilio Console.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio Messaging Security: SMS Pumping Protection & Geo Permissions',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'Requires OPERATOR_OR_PROVIDER_CONTROL_REQUIRED classification for console-only controls.',
  },

  // ----------------------------------------------------------------------------
  // DOMAIN: NUMBER_PORT_IN
  // ----------------------------------------------------------------------------
  'DEC-PIN-001': {
    decisionId: 'DEC-PIN-001',
    domain: 'NUMBER_PORT_IN',
    statement:
      'Twilio Port-In API allows submitting port requests with Letter of Authorization (LOA), Customer Service Record (CSR), and authorized subscriber details. Port orders undergo review, carrier submission, FOC scheduling, and completion.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio Porting API Documentation: PortInOrder Resource',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'Competitor products (KrispCall, JustCall, Aircall) provide a digital LOA signature step and status tracker.',
  },
  'DEC-PIN-002': {
    decisionId: 'DEC-PIN-002',
    domain: 'NUMBER_PORT_IN',
    statement:
      'Whether a port-in order can be targeted directly to a child subaccount via the Porting API, or must be initiated at the parent account and transferred upon completion, is not completely unambiguous in public documentation.',
    classification: 'CONTROLLED_LIVE_VALIDATION_REQUIRED',
    source: 'Twilio Porting API Reference: Subaccount Port-in Destination Scoping',
    researchedAt: '2026-10-20',
    requiresLiveValidation: true,
    notes:
      'Flags PORTING_PROVIDER_ACCOUNT_SCOPE_REQUIRES_CONTROLLED_VALIDATION and PORTING_WEBHOOK_SUBACCOUNT_CORRELATION_REQUIRES_CONTROLLED_VALIDATION remain active.',
  },

  // ----------------------------------------------------------------------------
  // DOMAIN: NUMBER_PORT_OUT
  // ----------------------------------------------------------------------------
  'DEC-POU-001': {
    decisionId: 'DEC-POU-001',
    domain: 'NUMBER_PORT_OUT',
    statement:
      'FCC and international regulations mandate that carriers must allow customers to port numbers out upon valid request. Twilio provides port-out notifications to parent account webhooks/emails.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio Regulatory & Port-Out Policy Documentation',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'VoIP Hub architecture must not implement artificial friction, but must verify customer identity to prevent unauthorized port-out fraud.',
  },
  'DEC-POU-002': {
    decisionId: 'DEC-POU-002',
    domain: 'NUMBER_PORT_OUT',
    statement:
      'A phone number must NEVER be released while a port-out is in progress. Doing so cancels the port and causes catastrophic carrier number loss.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio Number Porting Guidelines: Port-out Interlocks',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'Enforced by Phase 23D.6 release saga interlocks (ActivePortOutInterlock).',
  },

  // ----------------------------------------------------------------------------
  // DOMAIN: NUMBER_RELEASE
  // ----------------------------------------------------------------------------
  'DEC-REL-001': {
    decisionId: 'DEC-REL-001',
    domain: 'NUMBER_RELEASE',
    statement:
      'Releasing a number (DELETE /2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers/{PhoneNumberSid}.json) is IMMEDIATE and IRREVERSIBLE. The number enters carrier cooling pool and cannot be guaranteed recoverable.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio REST API Reference: IncomingPhoneNumbers Deletion',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'VoIP Hub Phase 23D.6 Release Saga enforces customer confirmation and active-call verification prior to release.',
  },

  // ----------------------------------------------------------------------------
  // DOMAIN: PRICING_AND_BILLING
  // ----------------------------------------------------------------------------
  'DEC-PRI-001': {
    decisionId: 'DEC-PRI-001',
    domain: 'PRICING_AND_BILLING',
    statement:
      'Canonical VoIP Hub retail pricing policy enforces a DEFAULT NUMBER RETAIL MARKUP of 30% over provider cost. Subscription plans do not impose quantity caps; each active number is billed recurringly.',
    classification: 'BUSINESS_POLICY_DECISION_REQUIRED',
    source: 'Phase 23E.1 Business Policy Specification',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'Provider cost must be snapshotted at quote time. RATE_PRECISION_SCALE_REQUIRES_VALIDATION remains active.',
  },

  // ----------------------------------------------------------------------------
  // DOMAIN: WEBHOOK_AND_SIGNING
  // ----------------------------------------------------------------------------
  'DEC-WEB-001': {
    decisionId: 'DEC-WEB-001',
    domain: 'WEBHOOK_AND_SIGNING',
    statement:
      'Twilio webhook HMAC signature verification (X-Twilio-Signature) strictly requires the Account Auth Token corresponding to the subaccount receiving the webhook. Twilio API Keys cannot validate webhook signatures.',
    classification: 'CONFIRMED_CURRENT_OFFICIAL_PROVIDER_DOCS',
    source: 'Twilio Security Documentation: Validating Webhooks (Twilio.validateRequest)',
    researchedAt: '2026-10-20',
    requiresLiveValidation: false,
    notes:
      'The child subaccount Auth Token must be stored in TelecomSecretVault under purpose WEBHOOK_VERIFICATION.',
  },
  'DEC-WEB-002': {
    decisionId: 'DEC-WEB-002',
    domain: 'WEBHOOK_AND_SIGNING',
    statement:
      'Twilio SharedKeys architecture enables webhook signing to be decoupled from the Account Auth Token and independently rotated. Decoupling webhook verification via SharedKeys is established as a future security migration candidate.',
    classification: 'FUTURE_PROVIDER_RESEARCH_REQUIRED',
    source: 'Twilio Documentation: SharedKeys & Webhook Verification',
    researchedAt: '2026-10-20',
    requiresLiveValidation: true,
    notes:
      'Deferred gate PARENT_TWILIO_ACCOUNT_PROTECTION_RESEARCH_MANDATORY preserves this research.',
  },
  'DEC-WEB-003': {
    decisionId: 'DEC-WEB-003',
    domain: 'WEBHOOK_AND_SIGNING',
    statement:
      'Migration of webhook HMAC signature verification from child Auth Token to Twilio SharedKeys requires formal security architecture design and certification before implementation. Certified Phase 22C-R3 architecture (subaccount Auth Token under WEBHOOK_VERIFICATION) remains active and certified.',
    classification: 'FUTURE_PROVIDER_RESEARCH_REQUIRED',
    source: 'Twilio Security Documentation: Webhook Verification Migration Roadmap',
    researchedAt: '2026-10-20',
    requiresLiveValidation: true,
    notes:
      'Gate TWILIO_SHAREDKEY_WEBHOOK_MIGRATION_REQUIRES_SECURITY_DESIGN remains active under PARENT_TWILIO_ACCOUNT_PROTECTION_RESEARCH_MANDATORY.',
  },
};
