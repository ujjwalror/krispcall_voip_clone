'use client';

import React, { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Settings, Volume2, Mic, Bell, Radio, Shield, CheckCircle2, AlertTriangle, Loader2, Sun, Moon, Palette } from 'lucide-react';
import { useTheme } from '@/components/providers/ThemeProvider';

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [autoRecording, setAutoRecording] = useState<boolean>(true);
  const [role, setRole] = useState<string>('agent');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);

  const fetchSettings = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/twilio/settings/recording');
      if (res.ok) {
        const data = await res.json();
        setAutoRecording(Boolean(data.autoRecordingEnabled));
        setRole(data.role || 'agent');
      }
    } catch (err) {
      console.error('Error fetching settings:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  const handleToggleAutoRecording = async (nextVal: boolean) => {
    if (role !== 'admin') return;
    setIsSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/twilio/settings/recording', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoRecordingEnabled: nextVal }),
      });
      if (res.ok) {
        setAutoRecording(nextVal);
        setMessage('Workspace call recording preferences updated successfully.');
      } else {
        const errData = await res.json().catch(() => ({}));
        setMessage(errData.error || 'Failed to update workspace setting.');
      }
    } catch (err) {
      console.error('Error updating recording setting:', err);
      setMessage('Network error updating setting.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="border-b border-slate-800 pb-4">
        <h1 className="text-xl font-bold text-slate-100">Agent & Telecom Settings</h1>
        <p className="text-xs text-slate-400">Configure WebRTC audio devices, workspace call recording, and alert preferences.</p>
      </div>

      <div className="space-y-6">
        {/* Appearance & Interface Theme */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Palette className="w-4 h-4 text-indigo-400" />
              <span>Appearance & Color Theme</span>
            </CardTitle>
          </CardHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <button
              onClick={() => setTheme('dark')}
              className={`p-4 rounded-xl border flex items-center gap-3 text-left transition-all ${
                theme === 'dark'
                  ? 'bg-slate-900 border-blue-500 ring-1 ring-blue-500'
                  : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
              }`}
            >
              <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 text-amber-400">
                <Moon className="w-5 h-5" />
              </div>
              <div>
                <p className="text-xs font-bold text-slate-100">Dark Interface</p>
                <p className="text-[11px] text-slate-400">Classic high-contrast dark theme for low-light environments.</p>
              </div>
            </button>

            <button
              onClick={() => setTheme('light')}
              className={`p-4 rounded-xl border flex items-center gap-3 text-left transition-all ${
                theme === 'light'
                  ? 'bg-slate-900 border-blue-500 ring-1 ring-blue-500'
                  : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
              }`}
            >
              <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 text-indigo-500">
                <Sun className="w-5 h-5" />
              </div>
              <div>
                <p className="text-xs font-bold text-slate-100">Light Interface</p>
                <p className="text-[11px] text-slate-400">Clean, crisp light SaaS dashboard theme for daytime productivity.</p>
              </div>
            </button>
          </div>
        </Card>

        {/* Workspace Call Recording Preferences */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Radio className="w-4 h-4 text-rose-400" />
              <span>Workspace Automatic Call Recording</span>
            </CardTitle>
            {role === 'admin' ? (
              <Badge variant="purple" size="sm">ADMIN CONTROL</Badge>
            ) : (
              <Badge variant="neutral" size="sm">AGENT VIEW</Badge>
            )}
          </CardHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 rounded-xl bg-slate-950/80 border border-slate-800">
              <div className="space-y-1 pr-4">
                <p className="text-xs font-bold text-slate-200 flex items-center gap-2">
                  <span>Automatic Recording for All Calls</span>
                  <Badge variant={autoRecording ? 'rose' : 'neutral'} size="sm">
                    {autoRecording ? 'AUTO REC ON' : 'AUTO REC OFF'}
                  </Badge>
                </p>
                <p className="text-[11px] text-slate-400">
                  When enabled, all outbound calls in the workspace default to recording ON. Individual agents can override this setting per-call in the dialer.
                </p>
              </div>

              {role === 'admin' ? (
                <button
                  onClick={() => handleToggleAutoRecording(!autoRecording)}
                  disabled={isSaving || isLoading}
                  className={`px-4 py-2 rounded-xl text-xs font-bold transition-all border shrink-0 ${
                    autoRecording
                      ? 'bg-rose-950/90 border-rose-600 text-rose-200 hover:bg-rose-900/90'
                      : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  {isSaving ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : autoRecording ? (
                    'Disable Auto REC'
                  ) : (
                    'Enable Auto REC'
                  )}
                </button>
              ) : (
                <span className="text-[10px] text-slate-500 font-mono">Managed by Admin</span>
              )}
            </div>

            {message && (
              <p className="text-xs text-emerald-400 font-medium flex items-center gap-1.5 pt-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>{message}</span>
              </p>
            )}
          </div>
        </Card>

        {/* WebRTC Audio Preferences */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Mic className="w-4 h-4 text-blue-400" />
              <span>WebRTC Audio Devices</span>
            </CardTitle>
          </CardHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1.5">Microphone Device</label>
                <select className="w-full bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 p-2.5 outline-none focus:border-blue-500">
                  <option>MacBook Pro Microphone (Built-in)</option>
                  <option>External USB Headset Microphone</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1.5">Speaker / Headset Output</label>
                <select className="w-full bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 p-2.5 outline-none focus:border-blue-500">
                  <option>MacBook Pro Speakers (Built-in)</option>
                  <option>External Headphones Output</option>
                </select>
              </div>
            </div>
          </div>
        </Card>

        {/* Ringtone & Notification Alert Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Bell className="w-4 h-4 text-amber-400" />
              <span>Inbound Ringtone & Call Alerts</span>
            </CardTitle>
          </CardHeader>
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 rounded-lg bg-slate-950/60 border border-slate-800">
              <div>
                <p className="text-xs font-semibold text-slate-200">Play Ringtone for Incoming Calls</p>
                <p className="text-[10px] text-slate-400">Audible alert when an incoming PSTN call is routed to your agent identity.</p>
              </div>
              <input type="checkbox" defaultChecked className="w-4 h-4 accent-blue-600 rounded" />
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
