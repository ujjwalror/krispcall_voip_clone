import 'server-only';
import crypto from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';

export const ALLOWED_KYC_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type AllowedKycMimeType = typeof ALLOWED_KYC_MIME_TYPES[number];

export const MAX_DOCUMENT_SIZE_BYTES = 5 * 1024 * 1024; // Strict 5MB limit per provider specs

export type DocumentValidationStatus = 'uploaded' | 'format_validated' | 'rejected' | 'deleted';


export interface ComplianceDocumentItem {
  id: string;
  organizationId: string;
  complianceProfileId: string;
  requirementKey: string;
  documentType: string;
  storageObjectPath: string;
  originalFilename: string;
  mimeType: AllowedKycMimeType;
  sizeBytes: number;
  sha256Hash: string;
  status: DocumentValidationStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDocumentParams {
  organizationId: string;
  complianceProfileId: string;
  requirementKey: string;
  documentType: string;
  originalFilename: string;
  mimeType: string;
  fileBuffer: Buffer;
  userId: string;
  userRole: string;
}

export class ComplianceDocumentService {
  /**
   * Asserts user role is owner or admin.
   */
  private static assertOwnerOrAdmin(role: string | null | undefined): void {
    if (role !== 'owner' && role !== 'admin') {
      throw new Error('UNAUTHORIZED_ROLE: Compliance document management requires Owner or Admin role.');
    }
  }

  /**
   * Validates file magic bytes signature against declared MIME type.
   */
  static validateMagicBytes(buffer: Buffer, declaredMime: string): void {
    if (!buffer || buffer.length < 4) {
      throw new Error('INVALID_FILE_CORRUPT: Uploaded document file is empty or unreadable.');
    }

    const mime = declaredMime.toLowerCase().trim();

    if (mime === 'application/pdf') {
      // PDF magic bytes: %PDF- (0x25 0x50 0x44 0x46)
      const header = buffer.subarray(0, 4).toString('utf8');
      if (!header.startsWith('%PDF')) {
        throw new Error('FILE_SIGNATURE_MISMATCH: File header does not match declared PDF format.');
      }
    } else if (mime === 'image/jpeg') {
      // JPEG magic bytes: 0xFF 0xD8 0xFF
      if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
        throw new Error('FILE_SIGNATURE_MISMATCH: File header does not match declared JPEG image format.');
      }
    } else if (mime === 'image/png') {
      // PNG magic bytes: 0x89 0x50 0x4E 0x47
      if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
        throw new Error('FILE_SIGNATURE_MISMATCH: File header does not match declared PNG image format.');
      }
    } else {
      throw new Error(`UNSUPPORTED_MIME_TYPE: '${declaredMime}' is not an accepted KYC document format.`);
    }
  }

  /**
   * Uploads file to private Supabase storage and creates compliance_documents database record.
   */
  static async uploadDocument(params: CreateDocumentParams): Promise<ComplianceDocumentItem> {
    this.assertOwnerOrAdmin(params.userRole);

    const mime = params.mimeType.toLowerCase().trim();
    if (!ALLOWED_KYC_MIME_TYPES.includes(mime as AllowedKycMimeType)) {
      throw new Error(`UNSUPPORTED_MIME_TYPE: Accepted formats are PDF, JPEG, and PNG. Received '${params.mimeType}'.`);
    }

    if (params.fileBuffer.length > MAX_DOCUMENT_SIZE_BYTES) {
      throw new Error(`FILE_TOO_LARGE: KYC document size exceeds the maximum limit of 5MB (${(params.fileBuffer.length / 1024 / 1024).toFixed(2)}MB).`);
    }

    // 1. Validate magic bytes signature
    this.validateMagicBytes(params.fileBuffer, mime);

    // 2. Calculate SHA-256 hash checksum
    const sha256Hash = crypto.createHash('sha256').update(params.fileBuffer).digest('hex');

    // 3. Construct storage path
    const randomUuid = crypto.randomUUID();
    const storageObjectPath = `${params.organizationId}/${params.complianceProfileId}/${randomUuid}.bin`;

    const supabase = createAdminClient() as any;

    // 4. Upload buffer to private storage bucket
    const { error: uploadErr } = await supabase.storage
      .from('compliance-documents-private')
      .upload(storageObjectPath, params.fileBuffer, {
        contentType: mime,
        upsert: false,
      });

    if (uploadErr) {
      console.error('[ComplianceDocumentService] Storage upload error:', uploadErr);
      throw new Error(`Failed to upload document to private storage: ${uploadErr.message}`);
    }

    // 5. Sanitize display filename for HTML injection prevention
    const safeFilename = (params.originalFilename || 'document').replace(/[^a-zA-Z0-9_.-]/g, '_');

    // 6. Insert database record
    const { data: docRecord, error: dbErr } = await supabase
      .from('compliance_documents')
      .insert({
        organization_id: params.organizationId,
        compliance_profile_id: params.complianceProfileId,
        requirement_key: params.requirementKey,
        document_type: params.documentType,
        storage_object_path: storageObjectPath,
        original_filename: safeFilename,
        mime_type: mime,
        size_bytes: params.fileBuffer.length,
        sha256_hash: sha256Hash,
        status: 'format_validated',
        created_by: params.userId,
      })
      .select('*')
      .single();


    if (dbErr || !docRecord) {
      console.error('[ComplianceDocumentService] DB insert error:', dbErr);
      // Clean up uploaded storage object if DB record creation failed
      await supabase.storage.from('compliance-documents-private').remove([storageObjectPath]);
      throw new Error(`Failed to record compliance document metadata: ${dbErr?.message || 'Database error'}`);
    }

    // Evaluate profile status transition
    try {
      const { ComplianceProfileService } = await import('./complianceProfileService');
      await ComplianceProfileService.evaluateProfileStatus(params.organizationId, params.complianceProfileId, params.userRole);
    } catch (err) {
      console.warn('[ComplianceDocumentService] Profile status evaluation error:', err);
    }

    return {
      id: docRecord.id,
      organizationId: docRecord.organization_id,
      complianceProfileId: docRecord.compliance_profile_id,
      requirementKey: docRecord.requirement_key,
      documentType: docRecord.document_type,
      storageObjectPath: docRecord.storage_object_path,
      originalFilename: docRecord.original_filename,
      mimeType: docRecord.mime_type,
      sizeBytes: Number(docRecord.size_bytes),
      sha256Hash: docRecord.sha256_hash,
      status: docRecord.status as DocumentValidationStatus,
      createdBy: docRecord.created_by,
      createdAt: docRecord.created_at,
      updatedAt: docRecord.updated_at,
    };
  }

  /**
   * Lists compliance documents for a profile.
   */
  static async getProfileDocuments(
    organizationId: string,
    profileId: string,
    userRole: string
  ): Promise<ComplianceDocumentItem[]> {
    this.assertOwnerOrAdmin(userRole);
    const supabase = createAdminClient() as any;

    const { data: docs, error } = await supabase
      .from('compliance_documents')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('compliance_profile_id', profileId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[ComplianceDocumentService] Error fetching documents:', error);
      throw new Error(`Failed to retrieve profile compliance documents: ${error.message}`);
    }

    return (docs || []).map((d: any) => ({
      id: d.id,
      organizationId: d.organization_id,
      complianceProfileId: d.compliance_profile_id,
      requirementKey: d.requirement_key,
      documentType: d.document_type,
      storageObjectPath: d.storage_object_path,
      originalFilename: d.original_filename,
      mimeType: d.mime_type,
      sizeBytes: Number(d.size_bytes),
      sha256Hash: d.sha256_hash,
      status: d.status as DocumentValidationStatus,
      createdBy: d.created_by,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
    }));
  }

  /**
   * Generates a short-lived presigned download URL for a document.
   */
  static async generateDownloadUrl(
    organizationId: string,
    documentId: string,
    userRole: string
  ): Promise<{ signedUrl: string; originalFilename: string }> {
    this.assertOwnerOrAdmin(userRole);
    const supabase = createAdminClient() as any;

    const { data: doc, error } = await supabase
      .from('compliance_documents')
      .select('*')
      .eq('id', documentId)
      .eq('organization_id', organizationId)
      .single();

    if (error || !doc) {
      throw new Error('Compliance document not found or access denied.');
    }

    // Create 5-minute signed URL
    const { data: signedData, error: signedErr } = await supabase.storage
      .from('compliance-documents-private')
      .createSignedUrl(doc.storage_object_path, 300);

    if (signedErr || !signedData?.signedUrl) {
      throw new Error(`Failed to generate secure download URL: ${signedErr?.message || 'Storage error'}`);
    }

    return {
      signedUrl: signedData.signedUrl,
      originalFilename: doc.original_filename,
    };
  }
}
