import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import type { CredentialPurpose, SecretStatus } from './types';
import type { StoredEnvelopeRecord, EnvelopeStorageAdapter } from './envelopeTelecomSecretVault';
import type { Database, Json } from '@/lib/types/database.types';

import { createAdminClient } from '@/lib/supabase/admin';

export interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number }>;
}

/**
 * ============================================================================
 * POSTGRESQL ENVELOPE STORAGE ADAPTER (PRODUCTION-ALIGNED)
 * ============================================================================
 * Implements persistent PostgreSQL storage for public.telecom_vault_secrets.
 *
 * Conforms to authoritative production schema:
 * - Columns: id, secret_reference, provider, secret_type, provider_account_id,
 *            ciphertext, wrapped_data_key, iv, auth_tag, key_id,
 *            encryption_version, status, metadata, created_at, updated_at, revoked_at.
 * - Secret purpose is stored canonically in `secret_type` with zero aliasing.
 * - Cryptographic material is persisted as PostgreSQL BYTEA fields.
 */
export class PostgresEnvelopeStorageAdapter implements EnvelopeStorageAdapter {
  private client: SupabaseClient | PgClientLike;
  private isSupabase: boolean;

  constructor(client?: SupabaseClient | PgClientLike) {
    if (typeof window !== 'undefined') {
      throw new Error('Security Error: PostgresEnvelopeStorageAdapter cannot be instantiated in browser context.');
    }
    if (client) {
      this.client = client;
      if ('from' in client && typeof (client as unknown as Record<string, unknown>).from === 'function') {
        this.isSupabase = true;
      } else if ('query' in client && typeof (client as unknown as Record<string, unknown>).query === 'function') {
        this.isSupabase = false;
      } else {
        this.isSupabase = true;
      }
    } else {
      this.client = createAdminClient();
      this.isSupabase = true;
    }
  }

  private static toByteaString(buf: Buffer): string {
    return `\\x${buf.toString('hex')}`;
  }

  private static parseBytea(val: unknown): Buffer {
    if (Buffer.isBuffer(val)) return val;
    if (typeof val === 'string') {
      if (val.startsWith('\\x') || val.startsWith('\\X')) {
        return Buffer.from(val.slice(2), 'hex');
      }
      return Buffer.from(val, 'hex');
    }
    return Buffer.alloc(0);
  }

  private static packMetadata(record: StoredEnvelopeRecord): Record<string, unknown> {
    return {
      ...(record.metadata || {}),
      key_identifier: record.key_identifier ?? null,
      account_reference: record.account_reference ?? null,
      algorithm: record.algorithm || 'AES-256-GCM',
      environment: record.environment || 'production',
      kek_version: record.kek_version ?? null,
      rotated_at: record.rotated_at ?? null,
      expires_at: record.expires_at ?? null,
    };
  }

  async insert(record: StoredEnvelopeRecord): Promise<void> {
    const metaToStore = PostgresEnvelopeStorageAdapter.packMetadata(record);

    if (this.isSupabase) {
      const supabase = this.client as SupabaseClient;
      const insertPayload: Database['public']['Tables']['telecom_vault_secrets']['Insert'] = {
        id: record.id,
        secret_reference: record.reference_id,
        provider: record.provider,
        secret_type: record.credential_purpose as Database['public']['Tables']['telecom_vault_secrets']['Insert']['secret_type'],
        provider_account_id: record.provider_account_id,
        ciphertext: PostgresEnvelopeStorageAdapter.toByteaString(record.encrypted_payload),
        wrapped_data_key: PostgresEnvelopeStorageAdapter.toByteaString(record.wrapped_dek),
        iv: PostgresEnvelopeStorageAdapter.toByteaString(record.nonce),
        auth_tag: PostgresEnvelopeStorageAdapter.toByteaString(record.auth_tag),
        key_id: record.kek_identifier,
        encryption_version: record.secret_version,
        status: record.status,
        metadata: metaToStore as Json,
        created_at: record.created_at,
        updated_at: record.updated_at,
        revoked_at: record.revoked_at ?? null,
      };

      const { error } = await supabase
        .from('telecom_vault_secrets')
        .insert(insertPayload);

      if (error) {
        throw new Error(`VAULT_STORAGE_ERROR: Failed to insert secret record: ${error.message}`);
      }
      return;
    }

    const pgClient = this.client as PgClientLike;
    const query = `
      INSERT INTO public.telecom_vault_secrets (
        id,
        secret_reference,
        provider,
        secret_type,
        provider_account_id,
        ciphertext,
        wrapped_data_key,
        iv,
        auth_tag,
        key_id,
        encryption_version,
        status,
        metadata,
        created_at,
        updated_at,
        revoked_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
      );
    `;
    const params = [
      record.id,
      record.reference_id,
      record.provider,
      record.credential_purpose,
      record.provider_account_id,
      record.encrypted_payload,
      record.wrapped_dek,
      record.nonce,
      record.auth_tag,
      record.kek_identifier,
      record.secret_version,
      record.status,
      JSON.stringify(metaToStore),
      record.created_at,
      record.updated_at,
      record.revoked_at ?? null,
    ];
    await pgClient.query(query, params);
  }

  async findByReference(referenceId: string): Promise<StoredEnvelopeRecord | null> {
    if (this.isSupabase) {
      const supabase = this.client as SupabaseClient;
      const { data, error } = await supabase
        .from('telecom_vault_secrets')
        .select('*')
        .eq('secret_reference', referenceId)
        .maybeSingle();

      if (error) {
        throw new Error(`VAULT_STORAGE_ERROR: Failed to lookup secret reference: ${error.message}`);
      }
      if (!data) return null;
      return this.mapRow(data as Record<string, unknown>);
    }

    const pgClient = this.client as PgClientLike;
    const res = await pgClient.query(
      `SELECT * FROM public.telecom_vault_secrets WHERE secret_reference = $1 LIMIT 1`,
      [referenceId]
    );
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0] as Record<string, unknown>);
  }

  async findByPurpose(providerAccountId: string, purpose: CredentialPurpose): Promise<StoredEnvelopeRecord | null> {
    if (this.isSupabase) {
      const supabase = this.client as SupabaseClient;
      const { data, error } = await supabase
        .from('telecom_vault_secrets')
        .select('*')
        .eq('provider_account_id', providerAccountId)
        .eq('secret_type', purpose)
        .eq('status', 'active')
        .order('encryption_version', { ascending: false })
        .limit(1);

      if (error) {
        throw new Error(`VAULT_STORAGE_ERROR: Failed to lookup secret by purpose: ${error.message}`);
      }
      if (!data || data.length === 0) return null;
      return this.mapRow(data[0] as Record<string, unknown>);
    }

    const pgClient = this.client as PgClientLike;
    const res = await pgClient.query(
      `SELECT * FROM public.telecom_vault_secrets 
       WHERE provider_account_id = $1 AND secret_type = $2 AND status = 'active'
       ORDER BY encryption_version DESC LIMIT 1`,
      [providerAccountId, purpose]
    );
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0] as Record<string, unknown>);
  }

  async updateStatus(referenceId: string, status: SecretStatus, updateFields?: Partial<StoredEnvelopeRecord>): Promise<boolean> {
    if (this.isSupabase) {
      const supabase = this.client as SupabaseClient;
      const updateData: Database['public']['Tables']['telecom_vault_secrets']['Update'] = {
        status,
        updated_at: new Date().toISOString(),
      };
      if (updateFields?.revoked_at) {
        updateData.revoked_at = updateFields.revoked_at;
      }
      const { error, count } = await supabase
        .from('telecom_vault_secrets')
        .update(updateData, { count: 'exact' })
        .eq('secret_reference', referenceId);

      if (error) return false;
      return (count ?? 0) > 0;
    }

    const pgClient = this.client as PgClientLike;
    const res = await pgClient.query(
      `UPDATE public.telecom_vault_secrets
       SET status = $1, updated_at = NOW()
       WHERE secret_reference = $2`,
      [status, referenceId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async update(record: StoredEnvelopeRecord): Promise<boolean> {
    const metaToStore = PostgresEnvelopeStorageAdapter.packMetadata(record);

    if (this.isSupabase) {
      const supabase = this.client as SupabaseClient;
      const updateData: Database['public']['Tables']['telecom_vault_secrets']['Update'] = {
        ciphertext: PostgresEnvelopeStorageAdapter.toByteaString(record.encrypted_payload),
        wrapped_data_key: PostgresEnvelopeStorageAdapter.toByteaString(record.wrapped_dek),
        iv: PostgresEnvelopeStorageAdapter.toByteaString(record.nonce),
        auth_tag: PostgresEnvelopeStorageAdapter.toByteaString(record.auth_tag),
        key_id: record.kek_identifier,
        encryption_version: record.secret_version,
        secret_type: record.credential_purpose as Database['public']['Tables']['telecom_vault_secrets']['Update']['secret_type'],
        status: record.status,
        metadata: metaToStore as Json,
        updated_at: new Date().toISOString(),
      };

      const { error, count } = await supabase
        .from('telecom_vault_secrets')
        .update(updateData, { count: 'exact' })
        .eq('secret_reference', record.reference_id);

      if (error) return false;
      return (count ?? 0) > 0;
    }

    const pgClient = this.client as PgClientLike;
    const query = `
      UPDATE public.telecom_vault_secrets
      SET ciphertext = $1,
          wrapped_data_key = $2,
          iv = $3,
          auth_tag = $4,
          key_id = $5,
          encryption_version = $6,
          secret_type = $7,
          status = $8,
          metadata = $9,
          updated_at = NOW()
      WHERE secret_reference = $10
    `;
    const params = [
      record.encrypted_payload,
      record.wrapped_dek,
      record.nonce,
      record.auth_tag,
      record.kek_identifier,
      record.secret_version,
      record.credential_purpose,
      record.status,
      JSON.stringify(metaToStore),
      record.reference_id,
    ];
    const res = await pgClient.query(query, params);
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Cryptographic Revocation and Logical Deletion:
   * Sets status to 'deleted', zeroes ciphertext with 32-byte non-empty buffer (satisfying
   * production non-empty bytea constraints), and sets revoked_at to NOW().
   */
  async deleteLogical(referenceId: string): Promise<boolean> {
    const now = new Date().toISOString();
    const zeroBuf = Buffer.alloc(32, 0);

    if (this.isSupabase) {
      const supabase = this.client as SupabaseClient;
      const zeroBytea = PostgresEnvelopeStorageAdapter.toByteaString(zeroBuf);
      const { error, count } = await supabase
        .from('telecom_vault_secrets')
        .update({
          status: 'deleted',
          ciphertext: zeroBytea,
          wrapped_data_key: zeroBytea,
          iv: zeroBytea,
          auth_tag: zeroBytea,
          revoked_at: now,
          updated_at: now,
        }, { count: 'exact' })
        .eq('secret_reference', referenceId)
        .neq('status', 'deleted');

      if (error) return false;
      return (count ?? 0) > 0;
    }

    const pgClient = this.client as PgClientLike;
    const res = await pgClient.query(
      `UPDATE public.telecom_vault_secrets
       SET status = 'deleted',
           ciphertext = $1,
           wrapped_data_key = $2,
           iv = $3,
           auth_tag = $4,
           revoked_at = NOW(),
           updated_at = NOW()
       WHERE secret_reference = $5 AND status != 'deleted'`,
      [zeroBuf, zeroBuf, zeroBuf, zeroBuf, referenceId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  private mapRow(row: Record<string, unknown>): StoredEnvelopeRecord {
    const meta: Record<string, unknown> =
      typeof row.metadata === 'string'
        ? JSON.parse(row.metadata)
        : ((row.metadata as Record<string, unknown>) || {});

    return {
      id: String(row.id),
      provider_account_id: String(row.provider_account_id),
      provider: String(row.provider),
      credential_purpose: row.secret_type as CredentialPurpose,
      reference_id: String(row.secret_reference),
      key_identifier: meta.key_identifier ? String(meta.key_identifier) : undefined,
      account_reference: meta.account_reference ? String(meta.account_reference) : undefined,
      encrypted_payload: PostgresEnvelopeStorageAdapter.parseBytea(row.ciphertext),
      nonce: PostgresEnvelopeStorageAdapter.parseBytea(row.iv),
      auth_tag: PostgresEnvelopeStorageAdapter.parseBytea(row.auth_tag),
      wrapped_dek: PostgresEnvelopeStorageAdapter.parseBytea(row.wrapped_data_key),
      kek_identifier: String(row.key_id),
      kek_version: meta.kek_version ? String(meta.kek_version) : undefined,
      secret_version: Number(row.encryption_version),
      algorithm: String(meta.algorithm || 'AES-256-GCM'),
      status: row.status as SecretStatus,
      environment: String(meta.environment || 'production'),
      created_at: new Date(String(row.created_at)).toISOString(),
      updated_at: new Date(String(row.updated_at)).toISOString(),
      rotated_at: meta.rotated_at ? new Date(String(meta.rotated_at)).toISOString() : undefined,
      revoked_at: row.revoked_at ? new Date(String(row.revoked_at)).toISOString() : undefined,
      expires_at: meta.expires_at ? new Date(String(meta.expires_at)).toISOString() : undefined,
      metadata: meta,
    };
  }
}
