import crypto from 'crypto';

/**
 * Server-only cryptographic utilities for CRM OAuth state signing
 * and AES-256-GCM token encryption/decryption.
 * MUST NEVER BE IMPORTED IN CLIENT COMPONENTS.
 */

function getEncryptionKey(): Buffer {
  const envKey = process.env.CRM_ENCRYPTION_KEY;

  if (!envKey || typeof envKey !== 'string' || envKey.trim() === '') {
    throw new Error('CRM Configuration Error: CRM_ENCRYPTION_KEY is not defined in environment variables.');
  }

  const cleanKey = envKey.trim();
  if (cleanKey.length < 32) {
    throw new Error('CRM Configuration Error: CRM_ENCRYPTION_KEY must be at least 32 characters or a 64-hex character string.');
  }

  // Derive 32-byte key via SHA-256
  return crypto.createHash('sha256').update(cleanKey).digest();
}

/**
 * Encrypts a sensitive credential string using AES-256-GCM.
 * Output format: "iv:ciphertext:authTag" (hex encoded)
 */
export function encryptToken(plaintext: string): string {
  if (!plaintext) return '';
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${encrypted}:${authTag}`;
}

/**
 * Decrypts a sensitive credential string encrypted with AES-256-GCM.
 */
export function decryptToken(encryptedString: string): string {
  if (!encryptedString) return '';
  const parts = encryptedString.split(':');
  if (parts.length !== 3) {
    throw new Error('CRM Security Error: Invalid encrypted token format.');
  }

  const [ivHex, ciphertextHex, authTagHex] = parts;
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);

  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

export interface OAuthStatePayload {
  userId: string;
  organizationId: string;
  provider: string;
  timestamp: number;
  nonce: string;
}

/**
 * Generates a signed OAuth state string binding the user & organization.
 */
export function createOAuthState(payload: Omit<OAuthStatePayload, 'timestamp' | 'nonce'>): string {
  const fullPayload: OAuthStatePayload = {
    ...payload,
    timestamp: Date.now(),
    nonce: crypto.randomBytes(16).toString('hex'),
  };

  const jsonStr = JSON.stringify(fullPayload);
  const encodedData = Buffer.from(jsonStr, 'utf8').toString('base64url');
  
  const key = getEncryptionKey();
  const hmac = crypto.createHmac('sha256', key).update(encodedData).digest('base64url');

  return `${encodedData}.${hmac}`;
}

/**
 * Validates and decodes a signed OAuth state string.
 * Enforces 15-minute maximum lifetime.
 */
export function verifyOAuthState(stateStr: string): OAuthStatePayload {
  if (!stateStr || !stateStr.includes('.')) {
    throw new Error('OAuth Security Error: Invalid state parameter structure.');
  }

  const [encodedData, signature] = stateStr.split('.');
  const key = getEncryptionKey();
  const expectedHmac = crypto.createHmac('sha256', key).update(encodedData).digest('base64url');

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedHmac))) {
    throw new Error('OAuth Security Error: State signature verification failed (CSRF attempt detected).');
  }

  const jsonStr = Buffer.from(encodedData, 'base64url').toString('utf8');
  const payload: OAuthStatePayload = JSON.parse(jsonStr);

  // Check 15 minute expiration (900,000 ms)
  const maxAgeMs = 15 * 60 * 1000;
  if (Date.now() - payload.timestamp > maxAgeMs) {
    throw new Error('OAuth Security Error: OAuth state has expired. Please initiate connection again.');
  }

  return payload;
}
