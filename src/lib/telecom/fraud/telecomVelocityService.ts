import { TelecomVelocityCheckParams, TelecomVelocityCheckResult } from './types';
import { TelecomDistributedVelocityService } from './telecomDistributedVelocityService';

interface VelocityBucket {
  timestamps: number[];
  destinations: string[];
  contentHashes: string[];
}

export class TelecomVelocityService {
  // Mode flag: in runtime, distributed_authoritative is the sole authoritative engine.
  // legacy_in_memory is retained strictly as an offline test adapter for pre-existing unit tests.
  private static testAdapterMode: 'legacy_in_memory' | 'distributed_authoritative' = 'legacy_in_memory';

  // In-memory sliding-window caches (retained as test adapter)
  private static userVoiceBuckets: Map<string, VelocityBucket> = new Map();
  private static orgVoiceBuckets: Map<string, VelocityBucket> = new Map();
  private static userMsgBuckets: Map<string, VelocityBucket> = new Map();
  private static orgMsgBuckets: Map<string, VelocityBucket> = new Map();

  // Configurable velocity thresholds (strictly preserved from verified HEAD)
  public static readonly USER_VOICE_CALLS_PER_MINUTE = 10;
  public static readonly USER_VOICE_CALLS_PER_HOUR = 60;
  public static readonly ORG_VOICE_CALLS_PER_MINUTE = 30;
  public static readonly ORG_VOICE_CALLS_PER_HOUR = 200;
  public static readonly USER_VOICE_DESTINATION_DIVERSITY_5MIN = 8;

  public static readonly USER_SMS_PER_MINUTE = 10;
  public static readonly USER_SMS_PER_HOUR = 100;
  public static readonly ORG_SMS_PER_MINUTE = 60;
  public static readonly ORG_SMS_PER_HOUR = 500;
  public static readonly USER_MMS_PER_MINUTE = 5;
  public static readonly DUPLICATE_CONTENT_THRESHOLD_1MIN = 3;

  /**
   * Sets the operational mode for TelecomVelocityService.
   */
  public static setTestAdapterMode(mode: 'legacy_in_memory' | 'distributed_authoritative'): void {
    this.testAdapterMode = mode;
  }

  public static getTestAdapterMode(): 'legacy_in_memory' | 'distributed_authoritative' {
    return this.testAdapterMode;
  }

  /**
   * Authoritative distributed Voice check & atomic consumption (Phase 24C).
   */
  public static async checkAndConsumeVoice(
    client: any,
    params: Omit<TelecomVelocityCheckParams, 'serviceType'> & { serviceType?: 'voice_outbound' }
  ): Promise<TelecomVelocityCheckResult> {
    if (this.testAdapterMode === 'legacy_in_memory' && (!client || typeof client.rpc !== 'function')) {
      const check = this.checkVoiceVelocity({
        ...params,
        serviceType: 'voice_outbound',
      });
      if (check.allowed) {
        this.recordVoiceAttempt({
          ...params,
          serviceType: 'voice_outbound',
        });
      }
      return check;
    }
    return TelecomDistributedVelocityService.checkAndConsumeVoice(client, params);
  }

  /**
   * Authoritative distributed Messaging check & atomic consumption (Phase 24C).
   */
  public static async checkAndConsumeMessaging(
    client: any,
    params: TelecomVelocityCheckParams
  ): Promise<TelecomVelocityCheckResult> {
    if (this.testAdapterMode === 'legacy_in_memory' && (!client || typeof client.rpc !== 'function')) {
      const check = this.checkMessagingVelocity(params);
      if (check.allowed) {
        this.recordMessagingAttempt(params);
      }
      return check;
    }
    return TelecomDistributedVelocityService.checkAndConsumeMessaging(client, params);
  }

  /**
   * Cleans old timestamps outside the maximum window (1 hour)
   */
  private static pruneBucket(bucket: VelocityBucket, now: number): void {
    const oneHourAgo = now - 60 * 60 * 1000;
    while (bucket.timestamps.length > 0 && bucket.timestamps[0] < oneHourAgo) {
      bucket.timestamps.shift();
      bucket.destinations.shift();
      bucket.contentHashes.shift();
    }
  }

  private static getOrCreateBucket(map: Map<string, VelocityBucket>, key: string): VelocityBucket {
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { timestamps: [], destinations: [], contentHashes: [] };
      map.set(key, bucket);
    }
    return bucket;
  }

  /**
   * Resets all in-memory buckets (primarily for testing and cache invalidation)
   */
  public static resetState(): void {
    this.userVoiceBuckets.clear();
    this.orgVoiceBuckets.clear();
    this.userMsgBuckets.clear();
    this.orgMsgBuckets.clear();
  }

  /**
   * Evaluates voice call velocity for both user and organization.
   * Administrative/Owner privileges CANNOT bypass this control.
   */
  public static checkVoiceVelocity(params: TelecomVelocityCheckParams): TelecomVelocityCheckResult {
    const { organizationId, userId, destination = '' } = params;
    const now = Date.now();
    const oneMinuteAgo = now - 60 * 1000;
    const fiveMinutesAgo = now - 5 * 60 * 1000;

    // 1. User Voice Velocity Check
    const userBucket = this.getOrCreateBucket(this.userVoiceBuckets, userId);
    this.pruneBucket(userBucket, now);

    const userCallsLastMinute = userBucket.timestamps.filter((t) => t >= oneMinuteAgo).length;
    if (userCallsLastMinute >= this.USER_VOICE_CALLS_PER_MINUTE) {
      return {
        allowed: false,
        limitType: 'user_call_velocity',
        currentRate: userCallsLastMinute,
        limitThreshold: this.USER_VOICE_CALLS_PER_MINUTE,
        retryAfterSeconds: 60,
        reason: `Exceeded user voice dialing velocity limit (${userCallsLastMinute}/${this.USER_VOICE_CALLS_PER_MINUTE} calls/min). Rapid dialing throttled.`,
      };
    }

    if (userBucket.timestamps.length >= this.USER_VOICE_CALLS_PER_HOUR) {
      return {
        allowed: false,
        limitType: 'user_call_velocity',
        currentRate: userBucket.timestamps.length,
        limitThreshold: this.USER_VOICE_CALLS_PER_HOUR,
        retryAfterSeconds: 300,
        reason: `Exceeded user hourly voice dialing limit (${userBucket.timestamps.length}/${this.USER_VOICE_CALLS_PER_HOUR} calls/hr).`,
      };
    }

    // 1b. Destination Diversity Check (Robocall / rapid dialing burst)
    const recentDestinations: string[] = [];
    for (let i = 0; i < userBucket.timestamps.length; i++) {
      if (userBucket.timestamps[i] >= fiveMinutesAgo && userBucket.destinations[i]) {
        recentDestinations.push(userBucket.destinations[i]);
      }
    }
    const uniqueDests = new Set(recentDestinations);
    if (uniqueDests.size >= this.USER_VOICE_DESTINATION_DIVERSITY_5MIN && !uniqueDests.has(destination)) {
      return {
        allowed: false,
        limitType: 'destination_diversity',
        currentRate: uniqueDests.size,
        limitThreshold: this.USER_VOICE_DESTINATION_DIVERSITY_5MIN,
        retryAfterSeconds: 120,
        reason: `Exceeded destination diversity threshold (${uniqueDests.size} unique numbers in 5 minutes). Rapid automated dialing detected.`,
      };
    }

    // 2. Organization Voice Velocity Check
    const orgBucket = this.getOrCreateBucket(this.orgVoiceBuckets, organizationId);
    this.pruneBucket(orgBucket, now);

    const orgCallsLastMinute = orgBucket.timestamps.filter((t) => t >= oneMinuteAgo).length;
    if (orgCallsLastMinute >= this.ORG_VOICE_CALLS_PER_MINUTE) {
      return {
        allowed: false,
        limitType: 'org_call_velocity',
        currentRate: orgCallsLastMinute,
        limitThreshold: this.ORG_VOICE_CALLS_PER_MINUTE,
        retryAfterSeconds: 60,
        reason: `Exceeded organization voice call velocity limit (${orgCallsLastMinute}/${this.ORG_VOICE_CALLS_PER_MINUTE} calls/min).`,
      };
    }

    if (orgBucket.timestamps.length >= this.ORG_VOICE_CALLS_PER_HOUR) {
      return {
        allowed: false,
        limitType: 'org_call_velocity',
        currentRate: orgBucket.timestamps.length,
        limitThreshold: this.ORG_VOICE_CALLS_PER_HOUR,
        retryAfterSeconds: 300,
        reason: `Exceeded organization hourly voice call limit (${orgBucket.timestamps.length}/${this.ORG_VOICE_CALLS_PER_HOUR} calls/hr).`,
      };
    }

    return { allowed: true };
  }

  /**
   * Records a voice call attempt in velocity tracking buckets.
   */
  public static recordVoiceAttempt(params: TelecomVelocityCheckParams): void {
    const { organizationId, userId, destination = '' } = params;
    const now = Date.now();

    const userBucket = this.getOrCreateBucket(this.userVoiceBuckets, userId);
    userBucket.timestamps.push(now);
    userBucket.destinations.push(destination);
    userBucket.contentHashes.push('');

    const orgBucket = this.getOrCreateBucket(this.orgVoiceBuckets, organizationId);
    orgBucket.timestamps.push(now);
    orgBucket.destinations.push(destination);
    orgBucket.contentHashes.push('');
  }

  /**
   * Evaluates messaging velocity for SMS/MMS.
   */
  public static checkMessagingVelocity(params: TelecomVelocityCheckParams): TelecomVelocityCheckResult {
    const { organizationId, userId, serviceType, contentHash = '' } = params;
    const isMms = serviceType === 'mms_outbound';
    const now = Date.now();
    const oneMinuteAgo = now - 60 * 1000;

    // 1. User Message Velocity Check
    const userBucket = this.getOrCreateBucket(this.userMsgBuckets, userId);
    this.pruneBucket(userBucket, now);

    const userMsgsLastMinute = userBucket.timestamps.filter((t) => t >= oneMinuteAgo).length;
    if (userMsgsLastMinute >= this.USER_SMS_PER_MINUTE) {
      return {
        allowed: false,
        limitType: 'user_sms_velocity',
        currentRate: userMsgsLastMinute,
        limitThreshold: this.USER_SMS_PER_MINUTE,
        retryAfterSeconds: 60,
        reason: `Exceeded user outbound messaging velocity limit (${userMsgsLastMinute}/${this.USER_SMS_PER_MINUTE} msgs/min).`,
      };
    }

    if (userBucket.timestamps.length >= this.USER_SMS_PER_HOUR) {
      return {
        allowed: false,
        limitType: 'user_sms_velocity',
        currentRate: userBucket.timestamps.length,
        limitThreshold: this.USER_SMS_PER_HOUR,
        retryAfterSeconds: 300,
        reason: `Exceeded user hourly messaging limit (${userBucket.timestamps.length}/${this.USER_SMS_PER_HOUR} msgs/hr).`,
      };
    }

    // 1b. MMS Burst Limit
    if (isMms) {
      const recentMms = userBucket.timestamps.filter((t) => t >= oneMinuteAgo).length;
      if (recentMms >= this.USER_MMS_PER_MINUTE) {
        return {
          allowed: false,
          limitType: 'mms_burst',
          currentRate: recentMms,
          limitThreshold: this.USER_MMS_PER_MINUTE,
          retryAfterSeconds: 60,
          reason: `Exceeded user outbound MMS velocity limit (${recentMms}/${this.USER_MMS_PER_MINUTE} MMS/min).`,
        };
      }
    }

    // 1c. Duplicate Content Hash (Spam blast detector)
    if (contentHash) {
      let duplicateCount = 0;
      for (let i = 0; i < userBucket.timestamps.length; i++) {
        if (userBucket.timestamps[i] >= oneMinuteAgo && userBucket.contentHashes[i] === contentHash) {
          duplicateCount++;
        }
      }
      if (duplicateCount >= this.DUPLICATE_CONTENT_THRESHOLD_1MIN) {
        return {
          allowed: false,
          limitType: 'spam_content_burst',
          currentRate: duplicateCount,
          limitThreshold: this.DUPLICATE_CONTENT_THRESHOLD_1MIN,
          retryAfterSeconds: 60,
          reason: `Repeated identical message burst detected (${duplicateCount} identical messages in 1 minute). Message throttled as potential spam.`,
        };
      }
    }

    // 2. Organization Message Velocity Check
    const orgBucket = this.getOrCreateBucket(this.orgMsgBuckets, organizationId);
    this.pruneBucket(orgBucket, now);

    const orgMsgsLastMinute = orgBucket.timestamps.filter((t) => t >= oneMinuteAgo).length;
    if (orgMsgsLastMinute >= this.ORG_SMS_PER_MINUTE) {
      return {
        allowed: false,
        limitType: 'org_sms_velocity',
        currentRate: orgMsgsLastMinute,
        limitThreshold: this.ORG_SMS_PER_MINUTE,
        retryAfterSeconds: 60,
        reason: `Exceeded organization outbound messaging velocity limit (${orgMsgsLastMinute}/${this.ORG_SMS_PER_MINUTE} msgs/min).`,
      };
    }

    if (orgBucket.timestamps.length >= this.ORG_SMS_PER_HOUR) {
      return {
        allowed: false,
        limitType: 'org_sms_velocity',
        currentRate: orgBucket.timestamps.length,
        limitThreshold: this.ORG_SMS_PER_HOUR,
        retryAfterSeconds: 300,
        reason: `Exceeded organization hourly messaging limit (${orgBucket.timestamps.length}/${this.ORG_SMS_PER_HOUR} msgs/hr).`,
      };
    }

    return { allowed: true };
  }

  /**
   * Records a message attempt in velocity tracking buckets.
   */
  public static recordMessagingAttempt(params: TelecomVelocityCheckParams): void {
    const { organizationId, userId, destination = '', contentHash = '' } = params;
    const now = Date.now();

    const userBucket = this.getOrCreateBucket(this.userMsgBuckets, userId);
    userBucket.timestamps.push(now);
    userBucket.destinations.push(destination);
    userBucket.contentHashes.push(contentHash);

    const orgBucket = this.getOrCreateBucket(this.orgMsgBuckets, organizationId);
    orgBucket.timestamps.push(now);
    orgBucket.destinations.push(destination);
    orgBucket.contentHashes.push(contentHash);
  }
}
