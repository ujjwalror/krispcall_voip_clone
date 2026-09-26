import 'server-only';
import crypto from 'crypto';
import { ComplianceResourceType } from './types';

export type ComplianceMutationOperation =
  | 'create_address'
  | 'create_end_user'
  | 'create_supporting_document'
  | 'create_bundle'
  | 'assign_item'
  | 'assign_item_to_bundle'
  | 'request_evaluation'
  | 'request_bundle_evaluation'
  | 'submit_bundle'
  | 'delete_end_user'
  | 'delete_bundle';

export interface ProviderMutationAuthorization {
  operation: ComplianceMutationOperation;
  organizationId: string;
  complianceProfileId: string;
  operationId: string;
}

export interface CreateAddressParams {
  friendlyName: string;
  customerName: string;
  street: string;
  city: string;
  region?: string;
  postalCode: string;
  isoCountry: string;
  authorization?: ProviderMutationAuthorization;
}

export interface CreateEndUserParams {
  friendlyName: string;
  type: 'business' | 'individual';
  attributes: Record<string, string>;
  authorization?: ProviderMutationAuthorization;
}

export interface CreateSupportingDocumentParams {
  friendlyName: string;
  type: string;
  attributes: Record<string, string>;
  fileBuffer?: Buffer;
  mimeType?: string;
  filename?: string;
  dispatchMode?: 'metadata_only' | 'multipart_with_evidence';
  authorization?: ProviderMutationAuthorization;
}

export interface CreateBundleParams {
  friendlyName: string;
  email: string;
  regulationSid?: string | null;
  isoCountry: string;
  numberType: string;
  endUserType: string;
  isTest?: boolean;
  authorization?: ProviderMutationAuthorization;
}

export interface AssignItemParams {
  bundleSid: string;
  objectSid: string;
  authorization?: ProviderMutationAuthorization;
}

export interface RequestEvaluationParams {
  bundleSid: string;
  authorization?: ProviderMutationAuthorization;
}

export interface SubmitBundleParams {
  bundleSid: string;
  statusCallback?: string;
  authorization?: ProviderMutationAuthorization;
}

export interface ProviderComplianceAdapter {
  createAddress(params: CreateAddressParams): Promise<{ addressSid: string }>;
  createEndUser(params: CreateEndUserParams): Promise<{ endUserSid: string }>;
  createSupportingDocument(params: CreateSupportingDocumentParams): Promise<{ supportingDocumentSid: string }>;
  createBundle(params: CreateBundleParams): Promise<{ bundleSid: string; status: string }>;
  assignItemToBundle(params: AssignItemParams): Promise<{ itemAssignmentSid: string }>;
  requestBundleEvaluation(params: RequestEvaluationParams): Promise<{ evaluationSid: string; status: string }>;
  submitBundle(params: SubmitBundleParams): Promise<{ bundleSid: string; status: string }>;
  getResourceStatus(resourceType: ComplianceResourceType, resourceSid: string): Promise<{ status: string; details?: any }>;
}

/**
 * Mock Provider Compliance Adapter for Phase 10.2B.1.
 * Guarantees ZERO live Twilio compliance mutations while returning realistic SIDs.
 */
export class MockProviderComplianceAdapter implements ProviderComplianceAdapter {
  private shouldSimulateTimeout: boolean = false;
  private mockStatusMap: Map<string, string> = new Map();

  constructor(options?: { simulateTimeout?: boolean }) {
    this.shouldSimulateTimeout = !!options?.simulateTimeout;
  }

  setSimulateTimeout(value: boolean) {
    this.shouldSimulateTimeout = value;
  }

  setMockStatus(resourceSid: string, status: string) {
    this.mockStatusMap.set(resourceSid, status);
  }

  private generateMockSid(prefix: string, seed: string): string {
    const hash = crypto.createHash('md5').update(seed).digest('hex');
    return `${prefix}${hash}`;
  }

  async createAddress(params: CreateAddressParams): Promise<{ addressSid: string }> {
    if (this.shouldSimulateTimeout) {
      throw new Error('TIMEOUT: Provider HTTP request timed out after 3000ms.');
    }
    const addressSid = this.generateMockSid('AD', JSON.stringify(params));
    this.mockStatusMap.set(addressSid, 'active');
    return { addressSid };
  }

  async createEndUser(params: CreateEndUserParams): Promise<{ endUserSid: string }> {
    if (this.shouldSimulateTimeout) {
      throw new Error('TIMEOUT: Provider HTTP request timed out after 3000ms.');
    }
    const endUserSid = this.generateMockSid('IT', JSON.stringify(params));
    this.mockStatusMap.set(endUserSid, 'active');
    return { endUserSid };
  }

  async createSupportingDocument(params: CreateSupportingDocumentParams): Promise<{ supportingDocumentSid: string }> {
    if (this.shouldSimulateTimeout) {
      throw new Error('TIMEOUT: Provider HTTP request timed out after 3000ms.');
    }
    const supportingDocumentSid = this.generateMockSid('RD', JSON.stringify(params));
    this.mockStatusMap.set(supportingDocumentSid, 'approved');
    return { supportingDocumentSid };
  }

  async createBundle(params: CreateBundleParams): Promise<{ bundleSid: string; status: string }> {
    if (this.shouldSimulateTimeout) {
      throw new Error('TIMEOUT: Provider HTTP request timed out after 3000ms.');
    }
    const bundleSid = this.generateMockSid('BU', JSON.stringify(params));
    this.mockStatusMap.set(bundleSid, 'draft');
    return { bundleSid, status: 'draft' };
  }

  async assignItemToBundle(params: AssignItemParams): Promise<{ itemAssignmentSid: string }> {
    if (this.shouldSimulateTimeout) {
      throw new Error('TIMEOUT: Provider HTTP request timed out after 3000ms.');
    }
    const itemAssignmentSid = this.generateMockSid('BV', `${params.bundleSid}:${params.objectSid}`);
    return { itemAssignmentSid };
  }

  async requestBundleEvaluation(params: RequestEvaluationParams): Promise<{ evaluationSid: string; status: string }> {
    if (this.shouldSimulateTimeout) {
      throw new Error('TIMEOUT: Provider HTTP request timed out after 3000ms.');
    }
    const evaluationSid = this.generateMockSid('EV', params.bundleSid);
    return { evaluationSid, status: 'passed' };
  }

  async submitBundle(params: SubmitBundleParams): Promise<{ bundleSid: string; status: string }> {
    if (this.shouldSimulateTimeout) {
      throw new Error('TIMEOUT: Provider HTTP request timed out after 3000ms.');
    }
    this.mockStatusMap.set(params.bundleSid, 'pending-review');
    return { bundleSid: params.bundleSid, status: 'pending-review' };
  }

  async getResourceStatus(resourceType: ComplianceResourceType, resourceSid: string): Promise<{ status: string; details?: any }> {
    const status = this.mockStatusMap.get(resourceSid) || 'succeeded';
    return { status, details: { mockResourceType: resourceType, mockSid: resourceSid } };
  }
}
