'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Bell, Mail, Check, AlertTriangle, Loader2, Info } from 'lucide-react';
import { useAuth } from '@/components/providers/AuthProvider';

interface RecipientOption {
  id: string;
  full_name: string;
  email: string;
  role: string;
}

interface NumberNotificationsSettingsProps {
  phoneNumberId: string;
}

export function NumberNotificationsSettings({ phoneNumberId }: NumberNotificationsSettingsProps) {
  const { profile } = useAuth();
  const canManage = profile?.role === 'owner' || profile?.role === 'admin';

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Preference State
  const [emailEnabled, setEmailEnabled] = useState<boolean>(true);
  const [notifyNewMessage, setNotifyNewMessage] = useState<boolean>(true);
  const [notifyMissedCall, setNotifyMissedCall] = useState<boolean>(true);
  const [notifyNewVoicemail, setNotifyNewVoicemail] = useState<boolean>(true);
  const [recipientMode, setRecipientMode] = useState<
    'assigned_members' | 'workspace_admins' | 'all_members' | 'selected_users'
  >('assigned_members');
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);

  // Eligible Workspace Members
  const [availableRecipients, setAvailableRecipients] = useState<RecipientOption[]>([]);
  const [deliveryStatus, setDeliveryStatus] = useState<string>('NOT_READY');

  const fetchSettings = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/phone-numbers/${phoneNumberId}/notifications`);
      if (res.ok) {
        const json = await res.json();
        if (json.settings) {
          setEmailEnabled(json.settings.email_notifications_enabled ?? true);
          setNotifyNewMessage(json.settings.notify_new_message ?? true);
          setNotifyMissedCall(json.settings.notify_missed_call ?? true);
          setNotifyNewVoicemail(json.settings.notify_new_voicemail ?? true);
          setRecipientMode(json.settings.recipient_mode || 'assigned_members');
          setSelectedUserIds(json.settings.recipient_user_ids || []);
        }
        setAvailableRecipients(json.availableRecipients || []);
        setDeliveryStatus(json.deliveryStatus || 'NOT_READY');
      } else {
        const errJson = await res.json().catch(() => ({}));
        setError(errJson.message || 'Failed to load notification settings.');
      }
    } catch (err) {
      console.error('[NumberNotificationsSettings] Error fetching:', err);
      setError('Network error loading notification preferences.');
    } finally {
      setIsLoading(false);
    }
  }, [phoneNumberId]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await fetch(`/api/phone-numbers/${phoneNumberId}/notifications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email_notifications_enabled: emailEnabled,
          notify_new_message: notifyNewMessage,
          notify_missed_call: notifyMissedCall,
          notify_new_voicemail: notifyNewVoicemail,
          recipient_mode: recipientMode,
          recipient_user_ids: selectedUserIds,
        }),
      });

      const json = await res.json();
      if (res.ok && json.success) {
        setSuccessMsg('Notification preferences saved successfully.');
        setTimeout(() => setSuccessMsg(null), 4000);
      } else {
        setError(json.message || 'Failed to save notification preferences.');
      }
    } catch (err) {
      console.error('[NumberNotificationsSettings] Error saving:', err);
      setError('Network error saving preferences.');
    } finally {
      setIsSaving(false);
    }
  };

  const toggleUserSelection = (userId: string) => {
    setSelectedUserIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  };

  return (
    <Card className="border-slate-200 dark:border-slate-800">
      <CardHeader>
        <CardTitle className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Bell className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <span>Notifications</span>
          </span>
          <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20">
            Email Delivery: {deliveryStatus}
          </span>
        </CardTitle>
      </CardHeader>

      <div className="p-4 space-y-5 text-xs">
        <p className="text-slate-500 dark:text-slate-400">
          Receive email alerts for important activity on this number.
        </p>

        {error && (
          <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-800 dark:text-rose-300 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {successMsg && (
          <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-300 flex items-center gap-2">
            <Check className="w-4 h-4 text-emerald-500 shrink-0" />
            <span>{successMsg}</span>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
            <span className="text-xs text-slate-400 ml-2">Loading notification settings...</span>
          </div>
        ) : (
          <div className="space-y-5">
            {/* Email Notifications ON/OFF Toggle */}
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-900 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
                  <Mail className="w-4 h-4" />
                </div>
                <div>
                  <span className="font-bold text-slate-900 dark:text-slate-100 block">
                    Email Notifications
                  </span>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">
                    Send email alerts when activity occurs on this line
                  </span>
                </div>
              </div>

              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={emailEnabled}
                  onChange={(e) => setEmailEnabled(e.target.checked)}
                  disabled={!canManage}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer dark:bg-slate-800 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:after:border-slate-600 peer-checked:bg-blue-600"></div>
              </label>
            </div>

            {/* Event Checkboxes & Recipient Selection when Enabled */}
            {emailEnabled && (
              <div className="space-y-4 pt-1">
                {/* Event Types */}
                <div className="space-y-2">
                  <label className="font-bold text-slate-900 dark:text-slate-100 block">
                    Alert Events
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <label className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center gap-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <input
                        type="checkbox"
                        checked={notifyNewMessage}
                        onChange={(e) => setNotifyNewMessage(e.target.checked)}
                        disabled={!canManage}
                        className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                      />
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        New Message
                      </span>
                    </label>

                    <label className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center gap-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <input
                        type="checkbox"
                        checked={notifyMissedCall}
                        onChange={(e) => setNotifyMissedCall(e.target.checked)}
                        disabled={!canManage}
                        className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                      />
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        Missed Call
                      </span>
                    </label>

                    <label className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center gap-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <input
                        type="checkbox"
                        checked={notifyNewVoicemail}
                        onChange={(e) => setNotifyNewVoicemail(e.target.checked)}
                        disabled={!canManage}
                        className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                      />
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        New Voicemail
                      </span>
                    </label>
                  </div>
                </div>

                {/* Recipient Selection */}
                <div className="space-y-2 pt-2">
                  <label className="font-bold text-slate-900 dark:text-slate-100 block">
                    Notification Recipients
                  </label>
                  <select
                    value={recipientMode}
                    onChange={(e: any) => setRecipientMode(e.target.value)}
                    disabled={!canManage}
                    className="w-full max-w-md px-3 py-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none font-semibold text-xs"
                  >
                    <option value="assigned_members">Assigned Team Members (Default)</option>
                    <option value="workspace_admins">Workspace Owners & Admins</option>
                    <option value="all_members">All Active Workspace Members</option>
                    <option value="selected_users">Specific Workspace Members</option>
                  </select>

                  {/* Multi-select user list if 'selected_users' */}
                  {recipientMode === 'selected_users' && (
                    <div className="mt-3 p-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2 max-w-md max-h-48 overflow-y-auto">
                      <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400 block">
                        Select eligible workspace members:
                      </span>
                      {availableRecipients.length === 0 ? (
                        <p className="text-slate-400 italic">No members found.</p>
                      ) : (
                        availableRecipients.map((rec) => (
                          <label
                            key={rec.id}
                            className="flex items-center justify-between p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-900 cursor-pointer"
                          >
                            <div className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={selectedUserIds.includes(rec.id)}
                                onChange={() => toggleUserSelection(rec.id)}
                                disabled={!canManage}
                                className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                              />
                              <span className="font-semibold text-slate-800 dark:text-slate-200">
                                {rec.full_name}
                              </span>
                            </div>
                            <span className="text-[10px] text-slate-400 font-mono">
                              {rec.email}
                            </span>
                          </label>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Delivery Info Banner */}
            <div className="p-3 rounded-xl bg-blue-50/70 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900/60 text-blue-800 dark:text-blue-300 flex items-start gap-2.5 text-[11px]">
              <Info className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
              <div>
                <span className="font-bold block">Delivery Provider Notice</span>
                <span>
                  Notification preferences will be saved to your number configuration. Live email
                  dispatch requires an authorized SMTP or email delivery integration.
                </span>
              </div>
            </div>

            {/* Save Button */}
            {canManage && (
              <div className="pt-2 flex justify-end">
                <Button
                  onClick={handleSave}
                  disabled={isSaving}
                  className="bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs px-4"
                >
                  {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
                  <span>Save Notification Preferences</span>
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
