import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { ComplianceProfileService } from './complianceProfileService';
import { ProviderOperationService } from './providerOperationService';
import { ProviderResourceMappingService, ResourceCompatibilityContext } from './providerResourceMappingService';
import { ComplianceFingerprintService } from './complianceFingerprint';
import { ProviderComplianceAdapter, ProviderMutationAuthorization } from './providerComplianceAdapter';
import { TwilioPreflightService } from './twilioPreflightService';
import { TwilioFieldMapper } from './twilioFieldMapper';
import { RegulatoryPreCheckService } from '../marketplace/regulatoryPreCheckService';
import { ComplianceProfileWithDetails, ProviderComplianceOperation, ComplianceOperationType } from './types';

export interface ProviderSubmissionResult {
  bundleSid: string | null;
  bundleStatus: string;
  operationsExecuted: number;
  operationsReused: number;
  steps: Array<{
    stepName: string;
    operationId: string;
    idempotencyKey: string;
    status: string;
    resourceSid?: string | null;
  }>;
}

export class ProviderSubmissionOrchestrator {
  /**
   * Executes or resumes the restartable multi-step provider submission pipeline.
   */
  static async executeSubmissionPipeline(
    organizationId: string,
    complianceProfileId: string,
    userRole: string,
    adapter: ProviderComplianceAdapter,
    userId?: string | null,
    clientOverride?: any
  ): Promise<ProviderSubmissionResult> {
    // 1. Enforce Role-Based Access Control
    if (userRole !== 'owner' && userRole !== 'admin') {
      throw new Error('UNAUTHORIZED_ROLE: Compliance submission orchestration requires owner or admin role access.');
    }
    await ProviderOperationService.verifyUserRole(organizationId, userId || null, userRole, clientOverride);

    // 2. Fetch compliance profile and latest requirement snapshot
    const profile = await ComplianceProfileService.getProfileById(organizationId, complianceProfileId, userRole, clientOverride);
    if (!profile) {
      throw new Error(`Compliance profile '${complianceProfileId}' not found.`);
    }

    if (profile.organizationId !== organizationId) {
      throw new Error('FORBIDDEN: Cross-tenant profile access denied.');
    }

    const latestSnapshot = profile.snapshots?.[0];
    if (!latestSnapshot) {
      throw new Error(`Compliance profile '${complianceProfileId}' has no requirement snapshot.`);
    }

    // 3. Dynamic Regulation Staleness Protection
    // Re-verify against live provider regulatory requirements to ensure snapshot is not stale
    const currentPreCheck = await RegulatoryPreCheckService.evaluateRequirements(
      profile.countryCode,
      latestSnapshot.numberType,
      profile.endUserType
    );

    if (
      latestSnapshot.providerRegulationId &&
      currentPreCheck.regulationId &&
      latestSnapshot.providerRegulationId !== currentPreCheck.regulationId
    ) {
      throw new Error(
        `STALE_REGULATION_CONTEXT: Regulatory requirements have updated (Active Regulation: '${currentPreCheck.regulationId}', Snapshot: '${latestSnapshot.providerRegulationId}'). Re-check preflight required.`
      );
    }

    // 4. Run Server-Authoritative Preflight Check
    const preflight = await TwilioPreflightService.runPreflight(organizationId, complianceProfileId, userRole, clientOverride);
    if (!preflight.ready) {
      throw new Error(`PREFLIGHT_FAILED: ${preflight.errors.join('; ')}`);
    }

    const snapshotPayload = latestSnapshot.requirementPayload;
    const compatContext: ResourceCompatibilityContext = {
      countryCode: profile.countryCode,
      numberType: latestSnapshot.numberType,
      endUserType: profile.endUserType,
      providerRegulationId: currentPreCheck.regulationId || latestSnapshot.providerRegulationId,
    };

    let operationsExecuted = 0;
    let operationsReused = 0;
    const stepsLog: ProviderSubmissionResult['steps'] = [];

    // Helper: Execute restartable idempotent step with request-local authorization
    const executeStep = async (
      stepName: string,
      opType: ComplianceOperationType,
      requiredScope: string,
      entityId: string,
      actionFn: (auth: ProviderMutationAuthorization) => Promise<{ resourceType: any; resourceSid: string; providerStatus?: string; sourceEntityId?: string }>
    ): Promise<{ resourceSid: string; operation: ProviderComplianceOperation }> => {
      const idempotencyKey = ComplianceFingerprintService.generateIdempotencyKey(
        organizationId,
        complianceProfileId,
        opType,
        entityId
      );

      const fingerprintPayload = {
        organizationId,
        complianceProfileId,
        operationType: opType,
        entityId,
        countryCode: profile.countryCode,
        numberType: latestSnapshot.numberType,
        endUserType: profile.endUserType,
        providerRegulationId: compatContext.providerRegulationId,
      };

      const { operation: opRecord } = await ProviderOperationService.getOrCreateOperation(
        organizationId,
        complianceProfileId,
        opType,
        idempotencyKey,
        fingerprintPayload,
        userRole,
        userId,
        clientOverride
      );

      if (opRecord.status === 'succeeded' && opRecord.providerResourceId) {
        operationsReused++;
        stepsLog.push({
          stepName,
          operationId: opRecord.id,
          idempotencyKey,
          status: 'succeeded_reused',
          resourceSid: opRecord.providerResourceId,
        });
        return { resourceSid: opRecord.providerResourceId, operation: opRecord };
      }

      if (opRecord.status === 'reconciliation_required') {
        throw new Error(`RECONCILIATION_REQUIRED: Step '${stepName}' requires provider status reconciliation before retry.`);
      }

      // Start operation
      const startedOp = await ProviderOperationService.startOperation(organizationId, opRecord.id, clientOverride);
      operationsExecuted++;

      // Construct request-local, immutable authorization token bound to durable operation record
      const authorization: ProviderMutationAuthorization = {
        operation: opType as any,
        organizationId,
        complianceProfileId,
        operationId: startedOp.id,
      };

      try {
        const res = await actionFn(authorization);
        const completedOp = await ProviderOperationService.completeOperation(
          organizationId,
          startedOp.id,
          res.resourceType,
          res.resourceSid,
          clientOverride
        );

        // Record provider SID mapping with explicit source entity identity
        await ProviderResourceMappingService.recordMapping(
          organizationId,
          complianceProfileId,
          res.resourceType,
          res.resourceSid,
          compatContext,
          res.sourceEntityId || entityId,
          res.providerStatus || 'active',
          {},
          clientOverride
        );

        stepsLog.push({
          stepName,
          operationId: completedOp.id,
          idempotencyKey,
          status: 'succeeded',
          resourceSid: res.resourceSid,
        });

        return { resourceSid: res.resourceSid, operation: completedOp };
      } catch (err: any) {
        const errMsg = err.message || '';
        if (errMsg.includes('TIMEOUT') || errMsg.includes('ambiguous') || errMsg.includes('ETIMEDOUT')) {
          await ProviderOperationService.markReconciliationRequired(organizationId, startedOp.id, 'PROVIDER_TIMEOUT', errMsg, clientOverride);
          throw new Error(`RECONCILIATION_REQUIRED: Step '${stepName}' encountered network timeout. Re-run reconciliation service.`);
        } else {
          await ProviderOperationService.failOperation(organizationId, startedOp.id, 'PROVIDER_REJECTED', errMsg, clientOverride);
          throw err;
        }
      }
    };

    // --- STEP 1: CREATE ADDRESS (IF REQUIRED) ---
    let addressSid: string | null = null;
    const addressRequired = TwilioFieldMapper.isAddressRequired(latestSnapshot as any, profile.fieldValues);
    if (addressRequired) {
      const { resourceSid } = await executeStep('create_address', 'create_address', 'create_address', 'primary_address', async (auth) => {
        const res = await adapter.createAddress({
          friendlyName: `Address - ${profile.legalName}`,
          customerName: profile.legalName,
          street: '123 Synthetic Business Way',
          city: 'Sydney',
          region: 'NSW',
          postalCode: '2000',
          isoCountry: profile.countryCode,
          authorization: auth,
        });
        return { resourceType: 'address', resourceSid: res.addressSid, providerStatus: 'active', sourceEntityId: 'primary_address' };
      });
      addressSid = resourceSid;
    }

    // --- STEP 2: CREATE END USER ---
    const mappedAttributes = TwilioFieldMapper.mapEndUserAttributes(profile.endUserType, profile.fieldValues, profile.legalName, profile.givenName, profile.familyName);
    const { resourceSid: endUserSid } = await executeStep('create_end_user', 'create_end_user', 'create_end_user', 'primary_end_user', async (auth) => {
      const res = await adapter.createEndUser({
        friendlyName: `EndUser - ${profile.legalName}`,
        type: profile.endUserType,
        attributes: mappedAttributes,
        authorization: auth,
      });
      return { resourceType: 'end_user', resourceSid: res.endUserSid, providerStatus: 'active', sourceEntityId: 'primary_end_user' };
    });

    // --- STEP 3: CREATE SUPPORTING DOCUMENTS ---
    const documentSids: string[] = [];
    const docRecords = profile.documents || [];
    for (const docRecord of docRecords) {
      if (docRecord.sizeBytes > 5 * 1024 * 1024) {
        throw new Error(`DOCUMENT_SIZE_EXCEEDED: Document '${docRecord.originalFilename}' exceeds maximum allowed size of 5MB.`);
      }

      const { resourceSid: docSid } = await executeStep(
        `create_doc_${docRecord.documentType}`,
        'create_supporting_document',
        'create_supporting_document',
        docRecord.id,
        async (auth) => {
          const res = await adapter.createSupportingDocument({
            friendlyName: `Doc - ${docRecord.originalFilename}`,
            type: docRecord.documentType,
            attributes: {
              sha256: docRecord.sha256Hash,
            },
            authorization: auth,
          });
          return { resourceType: 'supporting_document', resourceSid: res.supportingDocumentSid, providerStatus: 'approved', sourceEntityId: docRecord.id };
        }
      );
      documentSids.push(docSid);
    }

    // --- STEP 4: CREATE BUNDLE ---
    const { resourceSid: bundleSid } = await executeStep('create_bundle', 'create_bundle', 'create_bundle', 'primary_bundle', async (auth) => {
      const res = await adapter.createBundle({
        friendlyName: `Bundle - ${profile.legalName} (${profile.countryCode})`,
        email: 'compliance-notifications@krispcall.internal',
        regulationSid: compatContext.providerRegulationId || '',
        isoCountry: profile.countryCode,
        numberType: latestSnapshot.numberType,
        endUserType: profile.endUserType,
        authorization: auth,
      });
      return { resourceType: 'bundle', resourceSid: res.bundleSid, providerStatus: res.status, sourceEntityId: 'primary_bundle' };
    });

    // --- STEP 5: ASSIGN ITEMS TO BUNDLE ---
    // Assign End User
    await executeStep('assign_end_user', 'assign_item_to_bundle', 'assign_item', `${bundleSid}:${endUserSid}`, async (auth) => {
      const res = await adapter.assignItemToBundle({ bundleSid, objectSid: endUserSid, authorization: auth });
      return { resourceType: 'item_assignment', resourceSid: res.itemAssignmentSid, sourceEntityId: `${bundleSid}:${endUserSid}` };
    });

    // Assign Address if present
    if (addressSid) {
      await executeStep('assign_address', 'assign_item_to_bundle', 'assign_item', `${bundleSid}:${addressSid}`, async (auth) => {
        const res = await adapter.assignItemToBundle({ bundleSid, objectSid: addressSid, authorization: auth });
        return { resourceType: 'item_assignment', resourceSid: res.itemAssignmentSid, sourceEntityId: `${bundleSid}:${addressSid}` };
      });
    }

    // Assign Documents
    for (const docSid of documentSids) {
      await executeStep(`assign_doc_${docSid.slice(-8)}`, 'assign_item_to_bundle', 'assign_item', `${bundleSid}:${docSid}`, async (auth) => {
        const res = await adapter.assignItemToBundle({ bundleSid, objectSid: docSid, authorization: auth });
        return { resourceType: 'item_assignment', resourceSid: res.itemAssignmentSid, sourceEntityId: `${bundleSid}:${docSid}` };
      });
    }

    // --- STEP 6: EVALUATE BUNDLE ---
    const { operation: evalOp } = await executeStep('request_evaluation', 'request_bundle_evaluation', 'request_evaluation', bundleSid, async (auth) => {
      const res = await adapter.requestBundleEvaluation({ bundleSid, authorization: auth });
      if (res.status !== 'passed') {
        throw new Error(`EVALUATION_FAILED: Provider evaluation returned status '${res.status}'. Correction required.`);
      }
      return { resourceType: 'bundle', resourceSid: bundleSid, providerStatus: res.status, sourceEntityId: 'primary_bundle' };
    });

    // --- STEP 7: SUBMIT BUNDLE ---
    const { resourceSid: finalBundleSid } = await executeStep('submit_bundle', 'submit_bundle', 'submit_bundle', bundleSid, async (auth) => {
      const res = await adapter.submitBundle({ bundleSid, authorization: auth });
      return { resourceType: 'bundle', resourceSid: res.bundleSid, providerStatus: res.status, sourceEntityId: 'primary_bundle' };
    });

    return {
      bundleSid: finalBundleSid,
      bundleStatus: 'pending-review',
      operationsExecuted,
      operationsReused,
      steps: stepsLog,
    };
  }
}

