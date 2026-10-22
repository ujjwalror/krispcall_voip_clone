import 'server-only';
import crypto from 'crypto';
import { PortEvidenceItem, PortingDocumentConstraints } from './types';

export interface ValidatePortEvidenceParams {
  evidenceType: 'utility_bill' | 'loa_signed' | 'csr' | 'id_document' | 'regulatory_form';
  storageObjectPath: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  sha256Hash: string;
  documentDateIso?: string; // For invoice freshness check
  constraints: PortingDocumentConstraints;
}

export class PortEvidenceService {
  /**
   * Validates port evidence against dynamic provider adapter constraints.
   * Enforces MIME types, file size limits (e.g. 10 MB for Twilio), and invoice freshness.
   * Zero PII logging.
   */
  static validateEvidenceItem(params: ValidatePortEvidenceParams): PortEvidenceItem {
    const { constraints } = params;

    // 1. File Size Validation
    if (params.sizeBytes <= 0) {
      throw new Error('INVALID_DOCUMENT_SIZE: File is empty (0 bytes).');
    }

    if (params.sizeBytes > constraints.maxSizeBytes) {
      const maxMb = Math.round(constraints.maxSizeBytes / (1024 * 1024));
      throw new Error(
        `FILE_SIZE_EXCEEDED: Document size (${params.sizeBytes} bytes) exceeds provider maximum of ${maxMb} MB.`
      );
    }

    // 2. MIME Type Validation
    const normalizedMime = params.mimeType.toLowerCase().trim();
    const isSupportedMime = constraints.supportedMimeTypes.some(
      (m) => m.toLowerCase() === normalizedMime
    );
    if (!isSupportedMime) {
      throw new Error(
        `UNSUPPORTED_MIME_TYPE: File type '${normalizedMime}' is not permitted by provider adapter. Allowed: ${constraints.supportedMimeTypes.join(', ')}.`
      );
    }

    // 3. Freshness Validation (for utility bills)
    if (params.evidenceType === 'utility_bill' && params.documentDateIso) {
      const docDate = new Date(params.documentDateIso).getTime();
      const now = Date.now();
      const ageDays = (now - docDate) / (1000 * 60 * 60 * 24);

      if (ageDays > constraints.maxInvoiceAgeDays) {
        throw new Error(
          `DOCUMENT_EXPIRED: Utility bill must be dated within the preceding ${constraints.maxInvoiceAgeDays} days.`
        );
      }
    }

    // 4. SHA-256 Hash Validation
    if (!params.sha256Hash || !/^[a-f0-9]{64}$/i.test(params.sha256Hash)) {
      throw new Error('INVALID_HASH: Valid 64-character SHA-256 hash is required.');
    }

    // 5. Sanitize Filename (strip dangerous paths, non-ASCII)
    const sanitizedFilename = params.originalFilename
      .replace(/[^a-zA-Z0-9_\-\.]/g, '_')
      .slice(0, 100);

    return {
      id: crypto.randomUUID(),
      evidenceType: params.evidenceType,
      storageObjectPath: params.storageObjectPath,
      originalFilenameSanitized: sanitizedFilename,
      mimeType: normalizedMime,
      sizeBytes: params.sizeBytes,
      sha256Hash: params.sha256Hash.toLowerCase(),
      verifiedAt: new Date().toISOString(),
      uploadedAt: new Date().toISOString(),
    };
  }
}
