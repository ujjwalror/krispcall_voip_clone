import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { ProviderContext } from '@/lib/telecom/provider/types';
import { TelecomPortingProviderAdapter } from './adapters/telecomPortingAdapter';
import {
  DiscoverPortRequirementsParams,
  PortRequirementSnapshotRecord,
} from './types';

export class PortRequirementSnapshotService {
  /**
   * Discovers porting requirements from the provider adapter, generates an immutable
   * deterministic fingerprint, and persists or retrieves the requirement snapshot.
   */
  static async discoverAndPersistSnapshot(
    params: DiscoverPortRequirementsParams & { organizationId: string },
    adapter: TelecomPortingProviderAdapter,
    context: ProviderContext,
    client?: SupabaseClient | any
  ): Promise<PortRequirementSnapshotRecord> {
    if (!params.organizationId) {
      throw new Error('INVALID_ORGANIZATION_ID: organizationId is required.');
    }

    if (!context || !context.providerAccountId) {
      throw new Error('INVALID_PROVIDER_CONTEXT: ProviderContext is required.');
    }

    // Query adapter for structured requirements
    const discovered = await adapter.discoverPortRequirements(params, context);

    const db = client || createAdminClient();

    // Check if identical immutable snapshot already exists for organization
    const { data: existing, error: findErr } = await (db as any)
      .from('number_port_requirement_snapshots')
      .select('*')
      .eq('organization_id', params.organizationId)
      .eq('fingerprint', discovered.fingerprint)
      .maybeSingle();

    if (!findErr && existing) {
      return {
        id: existing.id,
        organizationId: existing.organization_id,
        provider: existing.provider,
        countryCode: existing.country_code,
        numberType: existing.number_type,
        direction: existing.direction,
        subjectType: existing.subject_type,
        losingCarrier: existing.losing_carrier,
        targetProviderAccountId: existing.target_provider_account_id,
        requiresAccountNumber: existing.requires_account_number,
        requiresPin: existing.requires_pin,
        requiresBillingAddress: existing.requires_billing_address,
        requiresUtilityInvoice: existing.requires_utility_invoice,
        requiresDigitalEloa: existing.requires_digital_eloa,
        requiresManualDocumentUpload: existing.requires_manual_document_upload,
        requiredDocuments: existing.required_documents || [],
        documentConstraints: existing.document_constraints || {},
        providerCapabilities: existing.provider_capabilities || {},
        fingerprint: existing.fingerprint,
        retrievedAt: existing.retrieved_at,
        createdAt: existing.created_at,
      };
    }

    // Insert new immutable snapshot
    const insertPayload = {
      organization_id: params.organizationId,
      provider: discovered.provider,
      country_code: discovered.countryCode,
      number_type: discovered.numberType,
      direction: discovered.direction,
      subject_type: discovered.subjectType,
      losing_carrier: discovered.losingCarrier || null,
      target_provider_account_id: discovered.targetProviderAccountId || null,
      requires_account_number: discovered.requiresAccountNumber,
      requires_pin: discovered.requiresPin,
      requires_billing_address: discovered.requiresBillingAddress,
      requires_utility_invoice: discovered.requiresUtilityInvoice,
      requires_digital_eloa: discovered.requiresDigitalEloa,
      requires_manual_document_upload: discovered.requiresManualDocumentUpload,
      required_documents: discovered.requiredDocuments,
      document_constraints: discovered.documentConstraints,
      provider_capabilities: discovered.providerCapabilities,
      fingerprint: discovered.fingerprint,
      retrieved_at: discovered.retrievedAt,
    };

    const { data: inserted, error: insertErr } = await (db as any)
      .from('number_port_requirement_snapshots')
      .insert(insertPayload)
      .select('*')
      .single();

    if (insertErr || !inserted) {
      throw new Error(`PERSISTENCE_FAILED: Failed to store requirement snapshot: ${insertErr?.message}`);
    }

    return {
      id: inserted.id,
      organizationId: inserted.organization_id,
      provider: inserted.provider,
      countryCode: inserted.country_code,
      numberType: inserted.number_type,
      direction: inserted.direction,
      subjectType: inserted.subject_type,
      losingCarrier: inserted.losing_carrier,
      targetProviderAccountId: inserted.target_provider_account_id,
      requiresAccountNumber: inserted.requires_account_number,
      requiresPin: inserted.requires_pin,
      requiresBillingAddress: inserted.requires_billing_address,
      requiresUtilityInvoice: inserted.requires_utility_invoice,
      requiresDigitalEloa: inserted.requires_digital_eloa,
      requiresManualDocumentUpload: inserted.requires_manual_document_upload,
      requiredDocuments: inserted.required_documents || [],
      documentConstraints: inserted.document_constraints || {},
      providerCapabilities: inserted.provider_capabilities || {},
      fingerprint: inserted.fingerprint,
      retrievedAt: inserted.retrieved_at,
      createdAt: inserted.created_at,
    };
  }

  /**
   * Retrieves an immutable requirement snapshot by ID.
   */
  static async getSnapshotById(
    snapshotId: string,
    organizationId: string,
    client?: SupabaseClient | any
  ): Promise<PortRequirementSnapshotRecord | null> {
    const db = client || createAdminClient();
    const { data: snapshot, error } = await (db as any)
      .from('number_port_requirement_snapshots')
      .select('*')
      .eq('id', snapshotId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error || !snapshot) {
      return null;
    }

    return {
      id: snapshot.id,
      organizationId: snapshot.organization_id,
      provider: snapshot.provider,
      countryCode: snapshot.country_code,
      numberType: snapshot.number_type,
      direction: snapshot.direction,
      subjectType: snapshot.subject_type,
      losingCarrier: snapshot.losing_carrier,
      targetProviderAccountId: snapshot.target_provider_account_id,
      requiresAccountNumber: snapshot.requires_account_number,
      requiresPin: snapshot.requires_pin,
      requiresBillingAddress: snapshot.requires_billing_address,
      requiresUtilityInvoice: snapshot.requires_utility_invoice,
      requiresDigitalEloa: snapshot.requires_digital_eloa,
      requiresManualDocumentUpload: snapshot.requires_manual_document_upload,
      requiredDocuments: snapshot.required_documents || [],
      documentConstraints: snapshot.document_constraints || {},
      providerCapabilities: snapshot.provider_capabilities || {},
      fingerprint: snapshot.fingerprint,
      retrievedAt: snapshot.retrieved_at,
      createdAt: snapshot.created_at,
    };
  }
}
