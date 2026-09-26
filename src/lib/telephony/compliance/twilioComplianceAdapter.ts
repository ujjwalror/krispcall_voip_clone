import 'server-only';
import { createTwilioServerClient } from '@/lib/twilio/client';
import {
  AssignItemParams,
  CreateAddressParams,
  CreateBundleParams,
  CreateEndUserParams,
  CreateSupportingDocumentParams,
  ProviderComplianceAdapter,
  ProviderMutationAuthorization,
  RequestEvaluationParams,
  SubmitBundleParams,
} from './providerComplianceAdapter';
import { ComplianceResourceType } from './types';

export class TwilioProviderComplianceAdapter implements ProviderComplianceAdapter {
  private clientOverride?: any;

  constructor(clientOverride?: any) {
    this.clientOverride = clientOverride;
  }

  /**
   * Enforces server-side provider mutation safety gate with request-local authorization validation.
   * Fails closed with PROVIDER_MUTATIONS_DISABLED, AUTHORIZATION_OPERATION_MISMATCH, or PROVIDER_MUTATION_SCOPE_DENIED.
   */
  private assertMutationsEnabled(requiredScope: string, authorization?: ProviderMutationAuthorization): void {
    const enabled = process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED === 'true';
    if (!enabled) {
      throw new Error('PROVIDER_MUTATIONS_DISABLED: Live Twilio compliance mutations are currently disabled on the server.');
    }

    if (authorization) {
      const normRequired = requiredScope.replace('_to_bundle', '').replace('bundle_', '');
      const normAuth = (authorization.operation || '').replace('_to_bundle', '').replace('bundle_', '');
      if (normAuth !== normRequired) {
        throw new Error(
          `AUTHORIZATION_OPERATION_MISMATCH: Authorization operation '${authorization.operation}' does not match required operation '${requiredScope}'.`
        );
      }
      return;
    }

    const activeScope = (process.env.TWILIO_COMPLIANCE_MUTATION_SCOPE || '').trim();
    const normRequired = requiredScope.replace('_to_bundle', '').replace('bundle_', '');
    const normActive = activeScope.replace('_to_bundle', '').replace('bundle_', '');

    if (normActive !== 'all' && normActive !== normRequired) {
      throw new Error(`PROVIDER_MUTATION_SCOPE_DENIED: Mutation operation '${requiredScope}' is not authorized under active scope '${activeScope}'.`);
    }
  }

  private getTwilioClient(): any {
    if (this.clientOverride) return this.clientOverride;
    return createTwilioServerClient();
  }

  async createAddress(params: CreateAddressParams): Promise<{ addressSid: string }> {
    this.assertMutationsEnabled('create_address', params.authorization);
    const client = this.getTwilioClient();
    const address = await client.addresses.create({
      friendlyName: params.friendlyName,
      customerName: params.customerName,
      street: params.street,
      city: params.city,
      region: params.region || '',
      postalCode: params.postalCode,
      isoCountry: params.isoCountry.toUpperCase(),
    });
    return { addressSid: address.sid };
  }

  async createEndUser(params: CreateEndUserParams): Promise<{ endUserSid: string }> {
    this.assertMutationsEnabled('create_end_user', params.authorization);
    const client = this.getTwilioClient();
    const endUser = await client.numbers.v2.regulatoryCompliance.endUsers.create({
      friendlyName: params.friendlyName,
      type: params.type,
      attributes: params.attributes,
    });
    return { endUserSid: endUser.sid };
  }

  async createSupportingDocument(params: CreateSupportingDocumentParams): Promise<{ supportingDocumentSid: string }> {
    this.assertMutationsEnabled('create_supporting_document', params.authorization);
    const client = this.getTwilioClient();

    if (params.dispatchMode === 'multipart_with_evidence' && params.fileBuffer) {
      // Direct multipart form evidence dispatch to numbers-upload.twilio.com
      const doc = await client.numbers.v2.regulatoryCompliance.supportingDocuments.create({
        friendlyName: params.friendlyName,
        type: params.type,
        attributes: params.attributes,
        file: params.fileBuffer,
      });
      return { supportingDocumentSid: doc.sid };
    }

    // Standard metadata-only creation via numbers.twilio.com/v2/RegulatoryCompliance/SupportingDocuments
    const doc = await client.numbers.v2.regulatoryCompliance.supportingDocuments.create({
      friendlyName: params.friendlyName,
      type: params.type,
      attributes: params.attributes,
    });
    return { supportingDocumentSid: doc.sid };
  }

  async createBundle(params: CreateBundleParams): Promise<{ bundleSid: string; status: string }> {
    this.assertMutationsEnabled('create_bundle', params.authorization);
    const client = this.getTwilioClient();
    const payload: any = {
      friendlyName: params.friendlyName,
      email: params.email,
      regulationSid: params.regulationSid || undefined,
      isoCountry: params.isoCountry.toUpperCase(),
      numberType: params.numberType,
      endUserType: params.endUserType,
    };
    if (params.isTest !== undefined) {
      payload.isTest = params.isTest;
    }
    const bundle = await client.numbers.v2.regulatoryCompliance.bundles.create(payload);
    return { bundleSid: bundle.sid, status: bundle.status || 'draft' };
  }

  async assignItemToBundle(params: AssignItemParams): Promise<{ itemAssignmentSid: string }> {
    this.assertMutationsEnabled('assign_item_to_bundle', params.authorization);
    const client = this.getTwilioClient();
    const assignment = await client.numbers.v2.regulatoryCompliance
      .bundles(params.bundleSid)
      .itemAssignments.create({
        objectSid: params.objectSid,
      });
    return { itemAssignmentSid: assignment.sid };
  }

  async requestBundleEvaluation(params: RequestEvaluationParams): Promise<{ evaluationSid: string; status: string }> {
    this.assertMutationsEnabled('request_bundle_evaluation', params.authorization);
    const client = this.getTwilioClient();
    const evaluation = await client.numbers.v2.regulatoryCompliance
      .bundles(params.bundleSid)
      .evaluations.create({});
    return { evaluationSid: evaluation.sid, status: evaluation.status || 'passed' };
  }

  async submitBundle(params: SubmitBundleParams): Promise<{ bundleSid: string; status: string }> {
    this.assertMutationsEnabled('submit_bundle', params.authorization);
    const client = this.getTwilioClient();
    const updated = await client.numbers.v2.regulatoryCompliance
      .bundles(params.bundleSid)
      .update({
        status: 'pending-review',
        statusCallback: params.statusCallback || undefined,
      });
    return { bundleSid: updated.sid, status: updated.status || 'pending-review' };
  }

  /**
   * Controlled Cleanup Method for Step 11.2 synthetic test End User deletion.
   */
  async deleteEndUser(endUserSid: string): Promise<{ deleted: boolean }> {
    this.assertMutationsEnabled('delete_end_user');
    const client = this.getTwilioClient();
    await client.numbers.v2.regulatoryCompliance.endUsers(endUserSid).remove();
    return { deleted: true };
  }

  /**
   * Controlled Cleanup Method for Step 11.4A synthetic test Bundle deletion.
   */
  async deleteBundle(bundleSid: string): Promise<{ deleted: boolean }> {
    this.assertMutationsEnabled('delete_bundle');
    const client = this.getTwilioClient();
    await client.numbers.v2.regulatoryCompliance.bundles(bundleSid).remove();
    return { deleted: true };
  }

  /**
   * Read-Only Provider Status Lookup.
   * Permitted even when mutation switch is disabled.
   */
  async getResourceStatus(resourceType: ComplianceResourceType, resourceSid: string): Promise<{ status: string; details?: any }> {
    const client = this.getTwilioClient();

    try {
      if (resourceType === 'address') {
        const addr = await client.addresses(resourceSid).fetch();
        return { status: 'active', details: { sid: addr.sid } };
      }
      if (resourceType === 'end_user') {
        const eu = await client.numbers.v2.regulatoryCompliance.endUsers(resourceSid).fetch();
        return { status: 'active', details: { sid: eu.sid, type: eu.type, friendlyName: eu.friendlyName } };
      }
      if (resourceType === 'supporting_document') {
        const doc = await client.numbers.v2.regulatoryCompliance.supportingDocuments(resourceSid).fetch();
        return { status: doc.status || 'approved', details: { sid: doc.sid, type: doc.type } };
      }
      if (resourceType === 'bundle') {
        const profile = await client.numbers.v2.regulatoryCompliance.bundles(resourceSid).fetch();
        const rawStatus = (profile.status || 'draft').toLowerCase();
        let status = rawStatus;
        if (rawStatus === 'twilio-approved' || rawStatus === 'approved') status = 'approved';
        if (rawStatus === 'twilio-rejected' || rawStatus === 'rejected') status = 'rejected';
        if (rawStatus === 'provisionally-approved' || rawStatus === 'provisionally_approved') status = 'provisionally_approved';
        return { status, details: { sid: profile.sid, validUntil: profile.validUntil } };
      }
    } catch (err: any) {
      return { status: 'unknown', details: { error: err.message } };
    }

    return { status: 'succeeded' };
  }
}
