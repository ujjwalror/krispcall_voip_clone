'use client';

export interface RingtoneOption {
  key: string;
  label: string;
  description: string;
  audioUrl: string;
}

export const RINGTONE_OPTIONS: RingtoneOption[] = [
  { key: 'classic', label: 'Classic', description: 'Standard dual-tone phone chime', audioUrl: '/audio/ringtones/classic.wav' },
  { key: 'soft', label: 'Soft', description: 'Calm marimba arpeggio chord', audioUrl: '/audio/ringtones/soft.wav' },
  { key: 'digital', label: 'Digital', description: 'Modern electronic office chime', audioUrl: '/audio/ringtones/digital.wav' },
  { key: 'pulse', label: 'Pulse', description: 'Rhythmic dual-frequency pulse', audioUrl: '/audio/ringtones/pulse.wav' },
  { key: 'minimal', label: 'Minimal', description: 'Subtle ambient bell chime', audioUrl: '/audio/ringtones/minimal.wav' },
];

export const DEFAULT_RINGTONE_KEY = 'classic';
export const DEFAULT_RINGTONE_VOLUME = 80;

class RingtoneEngine {
  private activeAudio: HTMLAudioElement | null = null;
  private previewAudio: HTMLAudioElement | null = null;
  private activeKey: string | null = null;
  private previewKey: string | null = null;

  private getAudioUrl(key: string): string {
    const found = RINGTONE_OPTIONS.find((opt) => opt.key === key);
    return found ? found.audioUrl : `/audio/ringtones/${DEFAULT_RINGTONE_KEY}.wav`;
  }

  /**
   * Plays incoming call ringtone continuously on loop at specified volume (0 - 100).
   * Stops any ongoing preview or previous ringtone instance.
   */
  public startIncomingRingtone(key: string, volumePercent: number): void {
    this.stopPreview();
    this.stopIncomingRingtone();

    const normalizedVol = Math.max(0, Math.min(100, Math.round(volumePercent))) / 100;
    const soundKey = RINGTONE_OPTIONS.some((o) => o.key === key) ? key : DEFAULT_RINGTONE_KEY;

    if (typeof window === 'undefined') return;

    try {
      const audio = new Audio(this.getAudioUrl(soundKey));
      audio.loop = true;
      audio.volume = normalizedVol;

      this.activeAudio = audio;
      this.activeKey = soundKey;

      if (normalizedVol > 0) {
        audio.play().catch((err) => {
          console.warn('[RingtoneEngine] Autoplay prevented or failed:', err);
        });
      }
    } catch (err) {
      console.warn('[RingtoneEngine] Error creating audio element:', err);
    }
  }

  /**
   * Immediately stops incoming call ringtone audio.
   */
  public stopIncomingRingtone(): void {
    if (this.activeAudio) {
      try {
        this.activeAudio.pause();
        this.activeAudio.currentTime = 0;
      } catch (e) {
        // Ignore pause errors
      }
      this.activeAudio = null;
      this.activeKey = null;
    }
  }

  /**
   * Plays a temporary preview ringtone at current slider volume (0 - 100).
   * Stops any ongoing incoming ringtone or previous preview instance.
   */
  public startPreview(key: string, volumePercent: number, onEnded?: () => void): void {
    this.stopIncomingRingtone();
    this.stopPreview();

    const normalizedVol = Math.max(0, Math.min(100, Math.round(volumePercent))) / 100;
    const soundKey = RINGTONE_OPTIONS.some((o) => o.key === key) ? key : DEFAULT_RINGTONE_KEY;

    if (typeof window === 'undefined') return;

    try {
      const audio = new Audio(this.getAudioUrl(soundKey));
      audio.loop = false;
      audio.volume = normalizedVol;

      if (onEnded) {
        audio.onended = () => {
          this.previewAudio = null;
          this.previewKey = null;
          onEnded();
        };
      }

      this.previewAudio = audio;
      this.previewKey = soundKey;

      if (normalizedVol > 0) {
        audio.play().catch((err) => {
          console.warn('[RingtoneEngine] Preview playback error:', err);
          if (onEnded) onEnded();
        });
      }
    } catch (err) {
      console.warn('[RingtoneEngine] Error initializing preview audio:', err);
      if (onEnded) onEnded();
    }
  }

  /**
   * Stops active ringtone preview audio.
   */
  public stopPreview(): void {
    if (this.previewAudio) {
      try {
        this.previewAudio.pause();
        this.previewAudio.currentTime = 0;
      } catch (e) {
        // Ignore
      }
      this.previewAudio = null;
      this.previewKey = null;
    }
  }

  /**
   * Dynamically adjusts volume in real-time for any currently active ringtone or preview.
   */
  public updateVolume(volumePercent: number): void {
    const normalizedVol = Math.max(0, Math.min(100, Math.round(volumePercent))) / 100;

    if (this.activeAudio) {
      this.activeAudio.volume = normalizedVol;
    }
    if (this.previewAudio) {
      this.previewAudio.volume = normalizedVol;
    }
  }

  public getPreviewKey(): string | null {
    return this.previewKey;
  }
}

export const ringtoneEngine = new RingtoneEngine();
