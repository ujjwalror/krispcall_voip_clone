'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Volume2, Volume1, Volume, VolumeX, Play, Square, Check, Bell } from 'lucide-react';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  ringtoneEngine,
  RINGTONE_OPTIONS,
  DEFAULT_RINGTONE_KEY,
  DEFAULT_RINGTONE_VOLUME,
} from '@/lib/audio/ringtoneEngine';

const VOLUME_BARS = [
  { threshold: 1, height: 4 },
  { threshold: 9, height: 5 },
  { threshold: 17, height: 7 },
  { threshold: 25, height: 8 },
  { threshold: 33, height: 10 },
  { threshold: 42, height: 11 },
  { threshold: 50, height: 13 },
  { threshold: 58, height: 14 },
  { threshold: 67, height: 16 },
  { threshold: 75, height: 17 },
  { threshold: 83, height: 19 },
  { threshold: 92, height: 21 },
];

export function PersonalRingtoneSettings() {
  const { profile, refreshProfile } = useAuth();

  const [ringtoneName, setRingtoneName] = useState<string>(
    (profile as any)?.ringtone_name || DEFAULT_RINGTONE_KEY
  );
  const [ringtoneVolume, setRingtoneVolume] = useState<number>(
    (profile as any)?.ringtone_volume ?? DEFAULT_RINGTONE_VOLUME
  );
  const [isPreviewing, setIsPreviewing] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [isInteracting, setIsInteracting] = useState<boolean>(false);

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Synchronize state when profile loads
  useEffect(() => {
    if (profile) {
      if ((profile as any).ringtone_name) {
        setRingtoneName((profile as any).ringtone_name);
      }
      if ((profile as any).ringtone_volume !== undefined && (profile as any).ringtone_volume !== null) {
        setRingtoneVolume((profile as any).ringtone_volume);
      }
    }
  }, [profile]);

  // Clean up preview & save timeout on unmount
  useEffect(() => {
    return () => {
      ringtoneEngine.stopPreview();
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  const savePreferences = async (name: string, vol: number) => {
    setIsSaving(true);
    setSaveMessage(null);
    try {
      const res = await fetch('/api/users/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ringtone_name: name,
          ringtone_volume: vol,
        }),
      });

      if (res.ok) {
        setSaveMessage('Saved!');
        await refreshProfile();
        setTimeout(() => setSaveMessage(null), 2500);
      } else {
        const data = await res.json().catch(() => ({}));
        setSaveMessage(data.error || 'Failed to save');
      }
    } catch (err) {
      console.error('[PersonalRingtoneSettings] Error saving preferences:', err);
      setSaveMessage('Error saving settings');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRingtoneChange = (newKey: string) => {
    setRingtoneName(newKey);
    savePreferences(newKey, ringtoneVolume);

    if (isPreviewing) {
      ringtoneEngine.startPreview(newKey, ringtoneVolume, () => setIsPreviewing(false));
    }
  };

  const handleVolumeChange = (newVol: number) => {
    setRingtoneVolume(newVol);
    ringtoneEngine.updateVolume(newVol);

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      savePreferences(ringtoneName, newVol);
    }, 350);
  };

  const togglePreview = () => {
    if (isPreviewing) {
      ringtoneEngine.stopPreview();
      setIsPreviewing(false);
    } else {
      setIsPreviewing(true);
      ringtoneEngine.startPreview(ringtoneName, ringtoneVolume, () => {
        setIsPreviewing(false);
      });
    }
  };

  // Dynamic speaker icon selection
  const getVolumeIcon = (vol: number) => {
    if (vol === 0) return VolumeX;
    if (vol <= 33) return Volume;
    if (vol <= 66) return Volume1;
    return Volume2;
  };

  const VolumeIcon = getVolumeIcon(ringtoneVolume);

  return (
    <Card className="border border-slate-200 dark:border-slate-800 shadow-sm">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Volume2 className="w-4 h-4 text-amber-500 dark:text-amber-400" />
            <span>Incoming Call Sound</span>
          </CardTitle>

          {saveMessage && (
            <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-1 animate-in fade-in">
              <Check className="w-3.5 h-3.5" />
              <span>{saveMessage}</span>
            </span>
          )}
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          Customize your personal ringtone sound and playback volume for incoming browser calls.
        </p>
      </CardHeader>

      <div className="space-y-5 p-4 pt-0">
        {/* Ringtone Selection */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-slate-800 dark:text-slate-200 block">
            Ringtone Tone
          </label>
          <div className="flex items-center gap-2.5">
            <select
              value={ringtoneName}
              onChange={(e) => handleRingtoneChange(e.target.value)}
              className="flex-1 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-medium text-slate-900 dark:text-slate-200 p-2.5 outline-none focus:border-blue-600 dark:focus:border-blue-500 transition-colors"
            >
              {RINGTONE_OPTIONS.map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {opt.label} — {opt.description}
                </option>
              ))}
            </select>

            <Button
              type="button"
              variant={isPreviewing ? 'secondary' : 'outline'}
              size="sm"
              onClick={togglePreview}
              className="flex items-center gap-1.5 text-xs font-medium min-w-[100px] justify-center"
            >
              {isPreviewing ? (
                <>
                  <Square className="w-3.5 h-3.5 fill-current text-rose-500" />
                  <span>Stop</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 fill-current text-blue-500" />
                  <span>Preview</span>
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Dynamic Ringtone Volume Slider & Visualization */}
        <div className="space-y-3.5 pt-4 border-t border-slate-100 dark:border-slate-800/80">
          {/* Header Row: Dynamic Speaker Icon, Title, and Visual Percentage */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-slate-100 dark:bg-slate-800/70 border border-slate-200/70 dark:border-slate-700/60 transition-colors">
                <VolumeIcon className={`w-4 h-4 transition-colors ${
                  ringtoneVolume === 0
                    ? 'text-slate-400 dark:text-slate-500'
                    : 'text-blue-600 dark:text-blue-400'
                }`} />
              </div>
              <div>
                <label htmlFor="ringtone-volume-slider" className="text-xs font-semibold text-slate-800 dark:text-slate-200 block cursor-pointer">
                  Ringtone Volume
                </label>
                <span className="text-[10px] text-slate-500 dark:text-slate-400 block">
                  {ringtoneVolume === 0 ? 'Muted (0%)' : `${ringtoneVolume}% output level`}
                </span>
              </div>
            </div>

            <span className="text-xs font-mono font-bold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/60 px-2.5 py-1 rounded-md border border-blue-200/60 dark:border-blue-800/60 shadow-2xs">
              {ringtoneVolume}%
            </span>
          </div>

          {/* Interactive Volume Control Box */}
          <div className="relative pt-6 pb-2 px-1 select-none">
            {/* Floating Value Bubble above Thumb */}
            {isInteracting && (
              <div
                className="absolute -top-1.5 -translate-x-1/2 flex flex-col items-center pointer-events-none transition-all duration-75 z-20"
                style={{ left: `calc(${ringtoneVolume}% + ${(50 - ringtoneVolume) * 0.16}px)` }}
              >
                <div className="bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-[11px] font-mono font-bold px-2 py-0.5 rounded shadow-lg border border-slate-700 dark:border-slate-300">
                  {ringtoneVolume}%
                </div>
                <div className="w-0 h-0 border-l-[4px] border-l-transparent border-r-[4px] border-r-transparent border-t-[5px] border-t-slate-900 dark:border-t-slate-100" />
              </div>
            )}

            {/* Slider Track with Custom Dynamic Fill Overlay */}
            <div className="relative flex items-center h-6">
              <div className="absolute inset-x-0 h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden pointer-events-none">
                <div
                  className="h-full bg-blue-600 dark:bg-blue-500 rounded-full transition-[width] duration-75 ease-out shadow-xs"
                  style={{ width: `${ringtoneVolume}%` }}
                />
              </div>

              <input
                id="ringtone-volume-slider"
                type="range"
                min="0"
                max="100"
                step="1"
                value={ringtoneVolume}
                onChange={(e) => handleVolumeChange(Number(e.target.value))}
                onPointerDown={() => setIsInteracting(true)}
                onPointerUp={() => setIsInteracting(false)}
                onTouchStart={() => setIsInteracting(true)}
                onTouchEnd={() => setIsInteracting(false)}
                onMouseDown={() => setIsInteracting(true)}
                onMouseUp={() => setIsInteracting(false)}
                onFocus={() => setIsInteracting(true)}
                onBlur={() => setIsInteracting(false)}
                className="relative z-10 w-full h-6 bg-transparent appearance-none cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900 rounded-lg custom-ringtone-slider"
                aria-label="Ringtone Volume"
              />
            </div>

            {/* Ascending Audio-Level Bars */}
            <div className="flex items-end justify-between gap-1 pt-3.5 px-0.5 h-7">
              {VOLUME_BARS.map((bar, idx) => {
                const isActive = ringtoneVolume > 0 && ringtoneVolume >= bar.threshold;
                return (
                  <div
                    key={idx}
                    className="flex-1 flex flex-col items-center justify-end h-full"
                  >
                    <div
                      style={{
                        height: `${bar.height}px`,
                        animationDelay: isPreviewing && isActive ? `${(idx % 6) * 110}ms` : '0ms',
                      }}
                      className={`w-full max-w-[10px] rounded-xs transition-all duration-150 ${
                        isActive
                          ? `bg-blue-600 dark:bg-blue-500 ${
                              isPreviewing ? 'animate-volume-pulse scale-y-110 opacity-90' : ''
                            }`
                          : 'bg-slate-200 dark:bg-slate-800'
                      }`}
                    />
                  </div>
                );
              })}
            </div>

            {/* Min / Max Labels */}
            <div className="flex items-center justify-between text-[10px] font-mono font-medium text-slate-400 dark:text-slate-500 pt-1.5">
              <span className="flex items-center gap-1">
                <VolumeX className="w-3 h-3 text-slate-400" />
                0%
              </span>
              <span className="flex items-center gap-1">
                100%
                <Volume2 className="w-3 h-3 text-slate-400" />
              </span>
            </div>
          </div>

          {/* Muted Warning Indicator */}
          {ringtoneVolume === 0 && (
            <div className="p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200/70 dark:border-amber-900/50 flex items-center gap-2 animate-in fade-in duration-200">
              <Bell className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <p className="text-xs text-amber-700 dark:text-amber-300 font-medium">
                Muted (Audio Only) — Incoming call popup will still display normally.
              </p>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
