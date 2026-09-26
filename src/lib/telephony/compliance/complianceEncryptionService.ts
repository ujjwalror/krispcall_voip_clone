import 'server-only';
import crypto from 'crypto';

export type SensitivityLevel = 'ordinary' | 'sensitive' | 'high_sensitivity';

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
  version: string;
}

/**
 * Server-only Encryption Service for sensitive KYC data protection using AES-256-GCM.
 * Never exposes encryption keys or plaintext sensitive data to browser clients.
 * Fails closed if encryption key is unconfigured or invalid.
 */
export class ComplianceEncryptionService {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly VERSION = 'v1';

  /**
   * Retrieves and validates the server encryption key from process.env.COMPLIANCE_ENCRYPTION_KEY.
   * Key MUST be a valid Base64 encoded string that decodes to EXACTLY 32 bytes (256 bits).
   * Fails closed with ENCRYPTION_KEY_UNAVAILABLE if missing or ENCRYPTION_KEY_INVALID if improper.
   */
  public static getEncryptionKey(): Buffer {
    const rawKey = process.env.COMPLIANCE_ENCRYPTION_KEY;
    if (!rawKey) {
      throw new Error(
        'ENCRYPTION_KEY_UNAVAILABLE: Server compliance encryption key is missing. Sensitive KYC storage blocked.'
      );
    }

    const trimmed = rawKey.trim();

    // Verify Base64 format regex (valid Base64 characters and padding)
    const isBase64Format = /^[A-Za-z0-9+/=]+$/.test(trimmed);
    if (!isBase64Format) {
      throw new Error(
        'ENCRYPTION_KEY_INVALID: COMPLIANCE_ENCRYPTION_KEY must be a valid Base64 encoded string.'
      );
    }

    const keyBuffer = Buffer.from(trimmed, 'base64');

    if (keyBuffer.length !== 32) {
      throw new Error(
        `ENCRYPTION_KEY_INVALID: COMPLIANCE_ENCRYPTION_KEY must decode to exactly 32 bytes (256 bits). Received ${keyBuffer.length} bytes.`
      );
    }

    return keyBuffer;
  }


  /**
   * Encrypts plaintext value using AES-256-GCM.
   */
  static encryptValue(plaintext: string): EncryptedPayload {
    const key = this.getEncryptionKey();
    const iv = crypto.randomBytes(12); // 96-bit IV for GCM

    const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv);
    let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
    ciphertext += cipher.final('hex');

    const authTag = cipher.getAuthTag().toString('hex');

    return {
      ciphertext,
      iv: iv.toString('hex'),
      authTag,
      version: this.VERSION,
    };
  }

  /**
   * Decrypts ciphertext value using AES-256-GCM.
   */
  static decryptValue(ciphertext: string, iv: string, authTag: string): string {
    const key = this.getEncryptionKey();
    const ivBuffer = Buffer.from(iv, 'hex');
    const authTagBuffer = Buffer.from(authTag, 'hex');

    const decipher = crypto.createDecipheriv(this.ALGORITHM, key, ivBuffer);
    decipher.setAuthTag(authTagBuffer);

    let plaintext = decipher.update(ciphertext, 'hex', 'utf8');
    plaintext += decipher.final('utf8');

    return plaintext;
  }

  /**
   * Classifies field sensitivity level based on key name and label.
   */
  static classifySensitivity(keyName: string, label?: string): SensitivityLevel {
    const combined = `${keyName}__${label || ''}`.toLowerCase();

    const isHighSensitivity =
      combined.includes('passport') ||
      combined.includes('ssn') ||
      combined.includes('national_id') ||
      combined.includes('tax_id') ||
      combined.includes('social_security') ||
      combined.includes('personal_id') ||
      combined.includes('identity_document_number');

    if (isHighSensitivity) {
      return 'high_sensitivity';
    }

    const isSensitive =
      combined.includes('address') ||
      combined.includes('birth_date') ||
      combined.includes('birth_place') ||
      combined.includes('registration_number') ||
      combined.includes('document_number') ||
      combined.includes('business_registration_number') ||
      combined.includes('id_number');

    if (isSensitive) {
      return 'sensitive';
    }

    return 'ordinary';
  }
}
