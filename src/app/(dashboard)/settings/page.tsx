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
} from 'lucide-react';
import { useTheme } from '@/components/providers/ThemeProvider';
import { Contact } from '@/lib/types';

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [activeTab, setActiveTab] = useState<'general' | 'blocked'>('general');

  // Settings State
  const [autoRecording, setAutoRecording] = useState<boolean>(true);
  const [role, setRole] = useState<string>('agent');
  const [isLoadingSettings, setIsLoadingSettings] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);

  // Blocked Contacts State
  const [blockedContacts, setBlockedContacts] = useState<Contact[]>([]);
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

  const fetchBlockedContacts = useCallback(async () => {
    setIsLoadingBlocked(true);
    try {
      const url = blockedSearchQuery.trim()
        ? `/api/contacts?query=${encodeURIComponent(blockedSearchQuery.trim())}`
        : '/api/contacts';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const allContacts: Contact[] = data.contacts || [];
        const blockedOnly = allContacts.filter((c) => Boolean(c.is_blocked));
        setBlockedContacts(blockedOnly);
      }
    } catch (err) {
      console.error('Error fetching blocked contacts:', err);
    } finally {
      setIsLoadingBlocked(false);
    }
  }, [blockedSearchQuery]);

  useEffect(() => {
    fetchSettings();
  }, []);

  useEffect(() => {
    if (activeTab === 'blocked') {
      fetchBlockedContacts();
    }
  }, [activeTab, fetchBlockedContacts]);

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

  const handleUnblockContact = async (contact: Contact) => {
    setUnblockingId(contact.id);
    setBlockedSuccessMessage(null);
    try {
      const res = await fetch(`/api/contacts/${contact.id}/block`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isBlocked: false }),
      });

      if (res.ok) {
        setBlockedContacts((prev) => prev.filter((c) => c.id !== contact.id));
        setBlockedSuccessMessage(`Unblocked ${contact.full_name} (${contact.phone}) successfully.`);
      } else {
        const errData = await res.json().catch(() => ({}));
        alert(errData.error || 'Failed to unblock contact.');
      }
    } catch (err) {
      console.error('Error unblocking contact:', err);
      alert('Network error unblocking contact.');
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
            Manage audio devices, workspace preferences, themes, and organization blocklists.
          </p>
        </div>

        {/* Settings Navigation Sub-Tabs */}
        <div className="flex items-center gap-1.5 p-1 rounded-xl bg-slate-950/80 border border-slate-800 text-xs">
          <button
            onClick={() => setActiveTab('general')}
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
            onClick={() => setActiveTab('blocked')}
            className={`px-3.5 py-1.5 rounded-lg font-semibold transition-all flex items-center gap-2 ${
              activeTab === 'blocked'
                ? 'bg-blue-600 text-white shadow-md'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
            }`}
          >
            <Ban className="w-3.5 h-3.5 text-rose-400" />
            <span>Blocked Contacts</span>
            {blockedContacts.length > 0 && (
              <span className="px-1.5 py-0.2 rounded-full bg-rose-950 text-rose-300 font-mono text-[10px] border border-rose-800">
                {blockedContacts.length}
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
                    disabled={isSaving || isLoadingSettings}
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
      ) : (
        /* Blocked Contacts Management Section */
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 w-full">
                <div>
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Ban className="w-4 h-4 text-rose-400" />
                    <span>Blocked Contacts Directory</span>
                  </CardTitle>
                  <p className="text-xs text-slate-400 mt-1">
                    Centralized list of all contacts and phone numbers blocked within your organization.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <Input
                    icon={<Search className="w-4 h-4" />}
                    placeholder="Search blocked contacts..."
                    value={blockedSearchQuery}
                    onChange={(e) => setBlockedSearchQuery(e.target.value)}
                    className="w-48 sm:w-60"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={fetchBlockedContacts}
                    title="Refresh blocked contacts list"
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
            ) : blockedContacts.length === 0 ? (
              <div className="p-12 text-center text-xs text-slate-500 space-y-2">
                <div className="w-12 h-12 rounded-2xl bg-slate-950 border border-slate-800 flex items-center justify-center mx-auto text-slate-600">
                  <Ban className="w-6 h-6" />
                </div>
                <p className="text-slate-300 font-bold">No Blocked Contacts Found</p>
                <p className="text-slate-500 max-w-sm mx-auto">
                  {blockedSearchQuery
                    ? `No blocked contacts match your search "${blockedSearchQuery}".`
                    : 'There are currently no blocked contacts in your organization directory.'}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {blockedContacts.map((contact) => (
                  <div
                    key={contact.id}
                    className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:border-slate-700 transition-colors"
                  >
                    <div className="flex items-start gap-3">
                      <Avatar name={contact.full_name || 'Blocked Contact'} size="md" />
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-bold text-slate-200">{contact.full_name}</h3>
                          <Badge variant="rose" size="sm">
                            <Ban className="w-2.5 h-2.5" />
                            BLOCKED
                          </Badge>
                        </div>

                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-xs font-mono text-slate-400">
                          <span className="flex items-center gap-1 text-slate-300">
                            <PhoneCall className="w-3 h-3 text-rose-400" />
                            <span>{contact.phone}</span>
                          </span>

                          {contact.email && (
                            <span className="flex items-center gap-1 text-slate-400 font-sans">
                              <Mail className="w-3 h-3 text-slate-500" />
                              <span>{contact.email}</span>
                            </span>
                          )}

                          {contact.company && (
                            <span className="flex items-center gap-1 text-slate-400 font-sans">
                              <Building className="w-3 h-3 text-slate-500" />
                              <span>{contact.company}</span>
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-end shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleUnblockContact(contact)}
                        disabled={unblockingId === contact.id}
                        className="font-bold border-rose-900/60 text-rose-300 hover:bg-rose-950/60 hover:text-white hover:border-rose-600 transition-all"
                      >
                        {unblockingId === contact.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        )}
                        <span>Unblock</span>
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
