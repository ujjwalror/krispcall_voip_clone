'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  Volume2,
  Mic,
  FileAudio,
  Radio,
  Save,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Upload,
  Trash2,
  Info,
  PhoneCall,
  PhoneForwarded,
} from 'lucide-react';

export interface CategoryAudioConfig {
  mode: 'tts' | 'custom_audio' | 'none';
  ttsMessage: string;
  ttsVoice: string;
  assetId: string | null;
  assetUrl?: string | null;
  fileName?: string | null;
}

export interface NumberAudioSettingsData {
  welcome: CategoryAudioConfig;
  voicemailGreeting: CategoryAudioConfig;
  hold: CategoryAudioConfig;
  transfer: CategoryAudioConfig;
}

export const VOICE_OPTIONS = [
  { value: 'Polly.Joanna', label: 'Joanna (US Female - Soft & Clear)' },
  { value: 'Polly.Matthew', label: 'Matthew (US Male - Professional)' },
  { value: 'Polly.Amy', label: 'Amy (UK Female - Professional)' },
  { value: 'Polly.Brian', label: 'Brian (UK Male - Clear & Direct)' },
];

export function GreetingsAudioSettings({ phoneNumberId }: { phoneNumberId: string }) {
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isUploading, setIsUploading] = useState<Record<string, boolean>>({});
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<'welcome' | 'voicemail' | 'hold' | 'transfer'>('welcome');

  const [audioSettings, setAudioSettings] = useState<NumberAudioSettingsData>({
    welcome: { mode: 'none', ttsMessage: 'Thank you for calling. Please stay on the line.', ttsVoice: 'Polly.Joanna', assetId: null },
    voicemailGreeting: { mode: 'none', ttsMessage: 'The person you are trying to reach is unavailable. Please leave a message after the tone.', ttsVoice: 'Polly.Joanna', assetId: null },
    hold: { mode: 'none', ttsMessage: 'Please hold while your call is being transferred or held.', ttsVoice: 'Polly.Joanna', assetId: null },
    transfer: { mode: 'none', ttsMessage: 'Please wait while we connect your call.', ttsVoice: 'Polly.Joanna', assetId: null },
  });

  const fetchAudioSettings = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/phone-numbers/${phoneNumberId}/audio`);
      if (res.ok) {
        const json = await res.json();
        if (json.settings) {
          setAudioSettings({
            welcome: {
              mode: json.settings.welcome?.mode || 'none',
              ttsMessage: json.settings.welcome?.ttsMessage || 'Thank you for calling. Please stay on the line.',
              ttsVoice: json.settings.welcome?.ttsVoice || 'Polly.Joanna',
              assetId: json.settings.welcome?.assetId || null,
            },
            voicemailGreeting: {
              mode: json.settings.voicemailGreeting?.mode || 'none',
              ttsMessage: json.settings.voicemailGreeting?.ttsMessage || 'The person you are trying to reach is unavailable. Please leave a message after the tone.',
              ttsVoice: json.settings.voicemailGreeting?.ttsVoice || 'Polly.Joanna',
              assetId: json.settings.voicemailGreeting?.assetId || null,
            },
            hold: {
              mode: json.settings.hold?.mode || 'none',
              ttsMessage: json.settings.hold?.ttsMessage || 'Please hold while your call is being transferred or held.',
              ttsVoice: json.settings.hold?.ttsVoice || 'Polly.Joanna',
              assetId: json.settings.hold?.assetId || null,
            },
            transfer: {
              mode: json.settings.transfer?.mode || 'none',
              ttsMessage: json.settings.transfer?.ttsMessage || 'Please wait while we connect your call.',
              ttsVoice: json.settings.transfer?.ttsVoice || 'Polly.Joanna',
              assetId: json.settings.transfer?.assetId || null,
            },
          });
        }
      }
    } catch (err) {
      console.error('[GreetingsAudioSettings] Error loading audio settings:', err);
    } finally {
      setIsLoading(false);
    }
  }, [phoneNumberId]);

  useEffect(() => {
    fetchAudioSettings();
  }, [fetchAudioSettings]);

  const handleModeChange = (category: keyof NumberAudioSettingsData, mode: 'tts' | 'custom_audio' | 'none') => {
    setAudioSettings((prev) => ({
      ...prev,
      [category]: {
        ...prev[category],
        mode,
      },
    }));
  };

  const handleTtsTextChange = (category: keyof NumberAudioSettingsData, text: string) => {
    setAudioSettings((prev) => ({
      ...prev,
      [category]: {
        ...prev[category],
        ttsMessage: text,
      },
    }));
  };

  const handleVoiceChange = (category: keyof NumberAudioSettingsData, voice: string) => {
    setAudioSettings((prev) => ({
      ...prev,
      [category]: {
        ...prev[category],
        ttsVoice: voice,
      },
    }));
  };

  const handleFileUpload = async (category: keyof NumberAudioSettingsData, event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      setErrorMessage(`File "${file.name}" exceeds maximum allowed size of 5 MB.`);
      return;
    }

    setIsUploading((prev) => ({ ...prev, [category]: true }));
    setErrorMessage(null);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('purpose', category);

      const res = await fetch(`/api/phone-numbers/${phoneNumberId}/audio/upload`, {
        method: 'POST',
        body: formData,
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'Failed to upload audio file.');
      }

      setAudioSettings((prev) => ({
        ...prev,
        [category]: {
          ...prev[category],
          mode: 'custom_audio',
          assetId: json.asset.id,
          fileName: json.asset.name,
        },
      }));

      setSuccessMessage(`Custom audio "${file.name}" uploaded successfully.`);
    } catch (err: any) {
      console.error('[FileUpload Error]', err);
      setErrorMessage(err.message || 'Error uploading custom audio file.');
    } finally {
      setIsUploading((prev) => ({ ...prev, [category]: false }));
    }
  };

  const handleSaveSettings = async () => {
    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const res = await fetch(`/api/phone-numbers/${phoneNumberId}/audio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(audioSettings),
      });

      const json = await res.json();
      if (!res.ok || !json.result?.success) {
        throw new Error(json.message || json.error || 'Failed to save audio configuration.');
      }

      setSuccessMessage('Greetings & Audio settings saved successfully.');
    } catch (err: any) {
      console.error('[SaveAudioSettings Error]', err);
      setErrorMessage(err.message || 'Failed to save Greetings & Audio settings.');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="p-12 text-center text-xs text-slate-500">
        <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-blue-500" />
        <span>Loading Greetings & Audio configuration...</span>
      </div>
    );
  }

  const currentCategoryKey = activeTab === 'welcome'
    ? 'welcome'
    : activeTab === 'voicemail'
    ? 'voicemailGreeting'
    : activeTab === 'hold'
    ? 'hold'
    : 'transfer';

  const categoryConfig = audioSettings[currentCategoryKey];

  return (
    <Card className="border-slate-200 dark:border-slate-800 space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Volume2 className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <span>Greetings & Audio</span>
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Configure spoken greetings, voicemail prompts, hold audio, and transfer audio for this phone number.
          </p>
        </div>

        <Button
          variant="primary"
          size="sm"
          onClick={handleSaveSettings}
          disabled={isSaving}
          className="flex items-center gap-2 font-bold shrink-0"
        >
          {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          <span>Save Changes</span>
        </Button>
      </div>

      {/* Notifications */}
      {successMessage && (
        <div className="p-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/80 border border-emerald-200 dark:border-emerald-700 text-emerald-800 dark:text-emerald-200 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span>{successMessage}</span>
          </div>
          <button onClick={() => setSuccessMessage(null)} className="text-emerald-600">✕</button>
        </div>
      )}

      {errorMessage && (
        <div className="p-3.5 rounded-xl bg-rose-50 dark:bg-rose-950/80 border border-rose-200 dark:border-rose-700 text-rose-800 dark:text-rose-200 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button onClick={() => setErrorMessage(null)} className="text-rose-600">✕</button>
        </div>
      )}

      {/* Category Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-3 overflow-x-auto">
        <button
          onClick={() => setActiveTab('welcome')}
          className={`px-3 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 ${
            activeTab === 'welcome'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200'
          }`}
        >
          <Volume2 className="w-3.5 h-3.5" />
          <span>Welcome Greeting</span>
        </button>

        <button
          onClick={() => setActiveTab('voicemail')}
          className={`px-3 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 ${
            activeTab === 'voicemail'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200'
          }`}
        >
          <Mic className="w-3.5 h-3.5" />
          <span>Voicemail Prompt</span>
        </button>

        <button
          onClick={() => setActiveTab('hold')}
          className={`px-3 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 ${
            activeTab === 'hold'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200'
          }`}
        >
          <PhoneCall className="w-3.5 h-3.5" />
          <span>Hold Audio</span>
        </button>

        <button
          onClick={() => setActiveTab('transfer')}
          className={`px-3 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 ${
            activeTab === 'transfer'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200'
          }`}
        >
          <PhoneForwarded className="w-3.5 h-3.5" />
          <span>Transfer Audio</span>
        </button>
      </div>

      {/* Call Menu Precedence Banner for Welcome Tab */}
      {activeTab === 'welcome' && (
        <div className="p-3.5 rounded-xl bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-800/60 text-xs text-blue-900 dark:text-blue-200 flex items-start gap-2.5">
          <Info className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
          <div>
            <span className="font-bold block">Using a Call Menu?</span>
            <span>
              If this number uses a Call Menu, the greeting from your Call Menu will be used instead of this Welcome Greeting.
            </span>
          </div>
        </div>
      )}

      {/* Mode Selection Cards */}
      <div className="space-y-4">
        <label className="text-xs font-bold text-slate-900 dark:text-slate-100 block">
          Audio Mode Selection
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {/* Option 1: Text to Speech */}
          <div
            onClick={() => handleModeChange(currentCategoryKey, 'tts')}
            className={`p-4 rounded-xl border cursor-pointer transition-all ${
              categoryConfig.mode === 'tts'
                ? 'border-blue-600 bg-blue-50/50 dark:bg-blue-950/40 ring-2 ring-blue-500/20'
                : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300'
            }`}
          >
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${categoryConfig.mode === 'tts' ? 'bg-blue-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-500'}`}>
                <Radio className="w-4 h-4" />
              </div>
              <div>
                <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100">Text to Speech</h4>
                <p className="text-[11px] text-slate-500 mt-0.5">Type a spoken message</p>
              </div>
            </div>
          </div>

          {/* Option 2: Custom Recording */}
          <div
            onClick={() => handleModeChange(currentCategoryKey, 'custom_audio')}
            className={`p-4 rounded-xl border cursor-pointer transition-all ${
              categoryConfig.mode === 'custom_audio'
                ? 'border-blue-600 bg-blue-50/50 dark:bg-blue-950/40 ring-2 ring-blue-500/20'
                : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300'
            }`}
          >
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${categoryConfig.mode === 'custom_audio' ? 'bg-blue-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-500'}`}>
                <FileAudio className="w-4 h-4" />
              </div>
              <div>
                <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100">Custom Recording</h4>
                <p className="text-[11px] text-slate-500 mt-0.5">Upload MP3 or WAV file</p>
              </div>
            </div>
          </div>

          {/* Option 3: None */}
          <div
            onClick={() => handleModeChange(currentCategoryKey, 'none')}
            className={`p-4 rounded-xl border cursor-pointer transition-all ${
              categoryConfig.mode === 'none'
                ? 'border-blue-600 bg-blue-50/50 dark:bg-blue-950/40 ring-2 ring-blue-500/20'
                : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300'
            }`}
          >
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${categoryConfig.mode === 'none' ? 'bg-blue-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-500'}`}>
                <Volume2 className="w-4 h-4" />
              </div>
              <div>
                <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100">None</h4>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {activeTab === 'welcome'
                    ? "Don't play a welcome greeting"
                    : activeTab === 'voicemail'
                    ? 'Play default voicemail tone'
                    : activeTab === 'hold'
                    ? 'Use standard hold audio'
                    : 'Use standard transfer audio'}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Mode Details Section */}
      {categoryConfig.mode === 'tts' && (
        <div className="p-5 rounded-2xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-slate-900 dark:text-slate-100">
              Spoken Greeting Message
            </label>
            <textarea
              rows={3}
              value={categoryConfig.ttsMessage}
              onChange={(e) => handleTtsTextChange(currentCategoryKey, e.target.value)}
              placeholder="Enter spoken greeting text..."
              className="w-full p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="space-y-1.5 max-w-sm">
            <label className="text-xs font-bold text-slate-900 dark:text-slate-100">
              Spoken Voice
            </label>
            <select
              value={categoryConfig.ttsVoice}
              onChange={(e) => handleVoiceChange(currentCategoryKey, e.target.value)}
              className="w-full p-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs text-slate-900 dark:text-slate-100 font-semibold"
            >
              {VOICE_OPTIONS.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {categoryConfig.mode === 'custom_audio' && (
        <div className="p-5 rounded-2xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-4">
          <div className="space-y-2">
            <label className="text-xs font-bold text-slate-900 dark:text-slate-100 block">
              Custom Audio File (MP3 / WAV, Max 5MB)
            </label>

            {categoryConfig.assetId ? (
              <div className="p-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <FileAudio className="w-4 h-4 text-blue-500" />
                  <span className="text-xs font-bold text-slate-900 dark:text-slate-100">
                    {categoryConfig.fileName || `Custom Audio (${categoryConfig.assetId})`}
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setAudioSettings((prev) => ({
                      ...prev,
                      [currentCategoryKey]: { ...prev[currentCategoryKey], assetId: null, fileName: null, mode: 'none' },
                    }))
                  }
                  className="text-xs text-rose-600 hover:text-rose-700 border-rose-200"
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1" />
                  <span>Remove</span>
                </Button>
              </div>
            ) : (
              <div className="relative border-2 border-dashed border-slate-300 dark:border-slate-700 rounded-2xl p-6 text-center hover:border-blue-500 transition-colors">
                <input
                  type="file"
                  accept="audio/mp3,audio/mpeg,audio/wav,audio/ogg"
                  onChange={(e) => handleFileUpload(currentCategoryKey, e)}
                  disabled={isUploading[currentCategoryKey]}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
                {isUploading[currentCategoryKey] ? (
                  <div className="flex items-center justify-center gap-2 text-xs text-blue-600 font-bold">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Uploading custom audio file...</span>
                  </div>
                ) : (
                  <div className="space-y-2 text-xs">
                    <Upload className="w-6 h-6 text-slate-400 mx-auto" />
                    <p className="font-bold text-slate-800 dark:text-slate-200">Click or drag file to upload</p>
                    <p className="text-[11px] text-slate-500">Supports MP3, WAV, OGG (Max 5.0 MB)</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {categoryConfig.mode === 'none' && (
        <div className="p-4 rounded-xl bg-slate-100 dark:bg-slate-900 text-xs text-slate-600 dark:text-slate-400 text-center font-medium">
          {activeTab === 'welcome'
            ? 'No welcome greeting will play. Calls will continue to your selected incoming call strategy.'
            : activeTab === 'voicemail'
            ? 'No custom voicemail greeting will play. The caller will continue directly to the voicemail tone.'
            : activeTab === 'hold'
            ? 'No custom hold message will play. Callers will hear the standard call-on-hold audio.'
            : 'No custom transfer audio will play. Callers will hear standard call progress audio while being connected.'}
        </div>
      )}
    </Card>
  );
}
