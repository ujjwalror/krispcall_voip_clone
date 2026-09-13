'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Avatar } from '@/components/ui/Avatar';
import {
  Settings,
  Volume2,
  Mic,
  Bell,
  Radio,
  Shield,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Sun,
  Moon,
  Palette,
  Ban,
  Search,
  Building,
  Mail,
  PhoneCall,
  UserCheck,
  RefreshCw,
  Sliders,
  UserX,
  Globe,
  Clock,
} from 'lucide-react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useTheme } from '@/components/providers/ThemeProvider';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  COMMON_TIMEZONES,
  getBrowserTimeZone,
  getFormattedTimeZoneLabel,
} from '@/lib/utils';

interface BlockedNumberItem {
  id: string;
  organization_id: string;
  phone_number: string;
  normalized_phone: string;
  contact_id: string | null;
  reason: string | null;
  created_at: string;
  contacts?: {
    id: string;
    full_name: string;
    email: string | null;
    company: string | null;
    phone: string;
  } | null;
}

function SettingsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialTab = searchParams.get('tab') === 'blocked' ? 'blocked' : 'general';

  const { theme, setTheme } = useTheme();
  const { profile, refreshProfile } = useAuth();
  const [activeTab, setActiveTab] = useState<'general' | 'blocked'>(initialTab);

  useEffect(() => {
    const tabParam = searchParams.get('tab');
    if (tabParam === 'blocked') {
      setActiveTab('blocked');
    } else if (tabParam === 'general') {
      setActiveTab('general');
    }
  }, [searchParams]);

  const handleTabChange = (tab: 'general' | 'blocked') => {
    setActiveTab(tab);
    router.replace(`/settings?tab=${tab}`);
  };

  // Settings State
  const [autoRecording, setAutoRecording] = useState<boolean>(true);
  const [role, setRole] = useState<string>('agent');
  const [isLoadingSettings, setIsLoadingSettings] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);

  // Per-User Regional Preferences State
  const defaultBrowserTz = getBrowserTimeZone();
  const [selectedTimezone, setSelectedTimezone] = useState<string>(
    profile?.timezone ? profile.timezone : 'AUTO'
  );
  const [selectedTimeFormat, setSelectedTimeFormat] = useState<'12h' | '24h'>(
    (profile?.time_format as '12h' | '24h') || '12h'
  );
  const [isSavingRegional, setIsSavingRegional] = useState<boolean>(false);
  const [regionalMessage, setRegionalMessage] = useState<string | null>(null);

  useEffect(() => {
    if (profile) {
      if (profile.timezone) {
        setSelectedTimezone(profile.timezone);
      } else {
        setSelectedTimezone('AUTO');
      }
      if (profile.time_format) {
        setSelectedTimeFormat(profile.time_format as '12h' | '24h');
      }
    }
  }, [profile]);

  const handleSaveRegionalPreferences = async () => {
    setIsSavingRegional(true);
    setRegionalMessage(null);
    try {
      const tzPayload = selectedTimezone === 'AUTO' ? null : selectedTimezone;
      const res = await fetch('/api/users/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timezone: tzPayload,
          time_format: selectedTimeFormat,
        }),
      });

      if (res.ok) {
        await refreshProfile();
        setRegionalMessage('Preferences saved');
      } else {
        const errData = await res.json().catch(() => ({}));
        alert(errData.error || 'Failed to save regional preferences.');
      }
    } catch (err) {
      console.error('Error saving regional preferences:', err);
      alert('Network error saving regional preferences.');
    } finally {
      setIsSavingRegional(false);
    }
  };

  // Blocked Numbers State
  const [blockedNumbers, setBlockedNumbers] = useState<BlockedNumberItem[]>([]);
  const [isLoadingBlocked, setIsLoadingBlocked] = useState<boolean>(false);
  const [blockedSearchQuery, setBlockedSearchQuery] = useState<string>('');
  const [unblockingId, setUnblockingId] = useState<string | null>(null);
  const [blockedSuccessMessage, setBlockedSuccessMessage] = useState<string | null>(null);

  const fetchSettings = async () => {
    setIsLoadingSettings(true);
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
      setIsLoadingSettings(false);
    }
  };

  const fetchBlockedNumbers = useCallback(async () => {
    setIsLoadingBlocked(true);
    try {
      const url = blockedSearchQuery.trim()
        ? `/api/blocked-numbers?query=${encodeURIComponent(blockedSearchQuery.trim())}`
        : '/api/blocked-numbers';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setBlockedNumbers(data.blockedNumbers || []);
      }
    } catch (err) {
      console.error('Error fetching blocked numbers:', err);
    } finally {
      setIsLoadingBlocked(false);
    }
  }, [blockedSearchQuery]);

  useEffect(() => {
    fetchSettings();
  }, []);

  useEffect(() => {
    if (activeTab === 'blocked') {
      fetchBlockedNumbers();
    }
  }, [activeTab, fetchBlockedNumbers]);

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

  const handleUnblockNumber = async (item: BlockedNumberItem) => {
    setUnblockingId(item.id);
    setBlockedSuccessMessage(null);
    try {
      const res = await fetch('/api/blocked-numbers', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: item.id,
          phone: item.normalized_phone || item.phone_number,
        }),
      });

      if (res.ok) {
        setBlockedNumbers((prev) => prev.filter((b) => b.id !== item.id));
        const label = item.contacts?.full_name || item.phone_number;
        setBlockedSuccessMessage(`Unblocked ${label} successfully.`);
      } else {
        const errData = await res.json().catch(() => ({}));
        alert(errData.error || 'Failed to unblock number.');
      }
    } catch (err) {
      console.error('Error unblocking number:', err);
      alert('Network error unblocking number.');
    } finally {
      setUnblockingId(null);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto pb-12">
      {/* Settings Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Settings className="w-5 h-5 text-blue-400" />
            <span>Settings & Administration</span>
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Manage WebRTC audio devices, workspace preferences, themes, and organization blocklists.
          </p>
        </div>

        {/* Settings Navigation Sub-Tabs */}
        <div className="flex items-center gap-1.5 p-1 rounded-xl bg-slate-950/80 border border-slate-800 text-xs overflow-x-auto max-w-full shrink-0">
          <button
            onClick={() => handleTabChange('general')}
            className={`px-3.5 py-1.5 rounded-lg font-semibold transition-all flex items-center gap-2 ${
              activeTab === 'general'
                ? 'bg-blue-600 text-white shadow-md'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            <span>General & Audio</span>
          </button>
          <button
            onClick={() => handleTabChange('blocked')}
            className={`px-3.5 py-1.5 rounded-lg font-semibold transition-all flex items-center gap-2 ${
              activeTab === 'blocked'
                ? 'bg-blue-600 text-white shadow-md'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
            }`}
          >
            <Ban className="w-3.5 h-3.5 text-rose-400" />
            <span>Blocked Numbers</span>
            {blockedNumbers.length > 0 && (
              <span className="px-1.5 py-0.2 rounded-full bg-rose-950 text-rose-300 font-mono text-[10px] border border-rose-800">
                {blockedNumbers.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {activeTab === 'general' ? (
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

          {/* Per-User Regional & Time Display Preferences */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Globe className="w-4 h-4 text-emerald-400" />
                <span>Regional & Time Display Preferences</span>
              </CardTitle>
            </CardHeader>
            <div className="space-y-4">
              <p className="text-xs text-slate-400">
                Configure your personal time zone and 12-hour or 24-hour time format. All call logs, recordings, and message timestamps update dynamically for your user profile.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Time Zone Selection */}
                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1.5 flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-blue-400" />
                    <span>Time Zone</span>
                  </label>
                  <select
                    value={selectedTimezone}
                    onChange={(e) => setSelectedTimezone(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-100 p-2.5 outline-none focus:border-blue-500 transition-colors"
                  >
                    <option value="AUTO">
                      Automatic — Device Time Zone ({getFormattedTimeZoneLabel(defaultBrowserTz, defaultBrowserTz)})
                    </option>
                    <optgroup label="Manual IANA Time Zones">
                      {COMMON_TIMEZONES.map((tz) => (
                        <option key={tz.iana} value={tz.iana}>
                          {getFormattedTimeZoneLabel(tz.iana, tz.label)}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  <p className="text-[10px] text-slate-500 mt-1">
                    {selectedTimezone === 'AUTO' ? (
                      <span>
                        Automatically using device timezone: <span className="font-mono text-slate-400">{defaultBrowserTz}</span>
                      </span>
                    ) : (
                      <span>
                        Manual override active: <span className="font-mono text-slate-300">{selectedTimezone}</span> (Device: {defaultBrowserTz})
                      </span>
                    )}
                  </p>
                </div>

                {/* 12-Hour vs 24-Hour Time Format Selection */}
                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                    Time Format
                  </label>
                  <div className="grid grid-cols-2 gap-2 p-1 rounded-xl bg-slate-950/80 border border-slate-800">
                    <button
                      type="button"
                      onClick={() => setSelectedTimeFormat('12h')}
                      className={`py-2 px-3 rounded-lg text-xs font-semibold transition-all ${
                        selectedTimeFormat === '12h'
                          ? 'bg-blue-600 text-white shadow'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      12-hour (3:45 PM)
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedTimeFormat('24h')}
                      className={`py-2 px-3 rounded-lg text-xs font-semibold transition-all ${
                        selectedTimeFormat === '24h'
                          ? 'bg-blue-600 text-white shadow'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      24-hour (15:45)
                    </button>
                  </div>
                </div>
              </div>

              {/* Save Controls & Feedback */}
              <div className="flex items-center justify-between pt-2 border-t border-slate-800">
                {regionalMessage ? (
                  <p className="text-xs text-emerald-400 font-medium flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>{regionalMessage}</span>
                  </p>
                ) : (
                  <span className="text-[10px] text-slate-500">
                    Timestamps in your profile update automatically across all pages.
                  </span>
                )}

                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSaveRegionalPreferences}
                  disabled={isSavingRegional}
                >
                  {isSavingRegional ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Saving...</span>
                    </>
                  ) : (
                    <span>Save Regional Preferences</span>
                  )}
                </Button>
              </div>
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
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-xl bg-slate-950/80 border border-slate-800 w-full">
                <div className="space-y-1.5 w-full sm:pr-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-bold text-slate-200">Automatic Recording for All Calls</span>
                    <Badge variant={autoRecording ? 'rose' : 'neutral'} size="sm">
                      {autoRecording ? 'AUTO REC ON' : 'AUTO REC OFF'}
                    </Badge>
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    When enabled, all outbound calls in the workspace default to recording ON. Individual agents can override this setting per-call in the dialer.
                  </p>
                </div>

                {role === 'admin' ? (
                  <button
                    onClick={() => handleToggleAutoRecording(!autoRecording)}
                    disabled={isSaving || isLoadingSettings}
                    className={`w-full sm:w-auto px-4 py-2.5 rounded-xl text-xs font-bold transition-all border shrink-0 flex items-center justify-center ${
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
      ) : (
        /* Blocked Numbers Management Section */
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 w-full">
                <div>
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Ban className="w-4 h-4 text-rose-400" />
                    <span>Blocked Numbers Directory</span>
                  </CardTitle>
                  <p className="text-xs text-slate-400 mt-1">
                    Organization-level blocklist of saved contacts and unsaved phone numbers.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <Input
                    icon={<Search className="w-4 h-4" />}
                    placeholder="Search blocked numbers..."
                    value={blockedSearchQuery}
                    onChange={(e) => setBlockedSearchQuery(e.target.value)}
                    className="w-48 sm:w-60"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={fetchBlockedNumbers}
                    title="Refresh blocked numbers list"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isLoadingBlocked ? 'animate-spin' : ''}`} />
                  </Button>
                </div>
              </div>
            </CardHeader>

            {blockedSuccessMessage && (
              <div className="p-3 mb-4 rounded-xl bg-emerald-950/80 border border-emerald-700 text-emerald-200 text-xs flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>{blockedSuccessMessage}</span>
                </div>
                <button
                  onClick={() => setBlockedSuccessMessage(null)}
                  className="text-emerald-400 hover:text-emerald-200 ml-2"
                >
                  ✕
                </button>
              </div>
            )}

            {isLoadingBlocked ? (
              <div className="p-12 text-center text-xs text-slate-400">
                <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-rose-400" />
                <span>Loading organization blocklist...</span>
              </div>
            ) : blockedNumbers.length === 0 ? (
              <div className="p-12 text-center text-xs text-slate-500 space-y-2">
                <div className="w-12 h-12 rounded-2xl bg-slate-950 border border-slate-800 flex items-center justify-center mx-auto text-slate-600">
                  <Ban className="w-6 h-6" />
                </div>
                <p className="text-slate-300 font-bold">No Blocked Numbers</p>
                <p className="text-slate-500 max-w-sm mx-auto">
                  {blockedSearchQuery
                    ? `No blocked numbers match your search "${blockedSearchQuery}".`
                    : 'There are currently no blocked numbers in your organization block list.'}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {blockedNumbers.map((item) => {
                  const hasContact = Boolean(item.contacts);
                  const titleName = item.contacts?.full_name || item.phone_number;

                  return (
                    <div
                      key={item.id}
                      className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:border-slate-700 transition-colors"
                    >
                      <div className="flex items-start gap-3">
                        <Avatar name={titleName} size="md" />
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="text-sm font-bold text-slate-200">{titleName}</h3>
                            <Badge variant="rose" size="sm">
                              <Ban className="w-2.5 h-2.5" />
                              BLOCKED
                            </Badge>

                            {hasContact ? (
                              <Badge variant="blue" size="sm">
                                <UserCheck className="w-2.5 h-2.5" />
                                Saved Contact
                              </Badge>
                            ) : (
                              <Badge variant="neutral" size="sm">
                                <UserX className="w-2.5 h-2.5" />
                                Not saved as contact
                              </Badge>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-xs font-mono text-slate-400">
                            <span className="flex items-center gap-1 text-slate-300">
                              <PhoneCall className="w-3 h-3 text-rose-400" />
                              <span>{item.phone_number}</span>
                            </span>

                            {item.contacts?.email && (
                              <span className="flex items-center gap-1 text-slate-400 font-sans">
                                <Mail className="w-3 h-3 text-slate-500" />
                                <span>{item.contacts.email}</span>
                              </span>
                            )}

                            {item.contacts?.company && (
                              <span className="flex items-center gap-1 text-slate-400 font-sans">
                                <Building className="w-3 h-3 text-slate-500" />
                                <span>{item.contacts.company}</span>
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center justify-end shrink-0">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleUnblockNumber(item)}
                          disabled={unblockingId === item.id}
                          className="font-bold border-rose-300 dark:border-rose-900/60 text-rose-600 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-950/60 hover:text-rose-900 dark:hover:text-white hover:border-rose-500 transition-all"
                        >
                          {unblockingId === item.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          )}
                          <span>Unblock</span>
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <React.Suspense
      fallback={
        <div className="p-12 text-center text-xs text-slate-400">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-blue-400" />
          <span>Loading settings...</span>
        </div>
      }
    >
      <SettingsContent />
    </React.Suspense>
  );
}
