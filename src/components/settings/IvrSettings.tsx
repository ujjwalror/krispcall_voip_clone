'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  PhoneCall,
  Lock,
  Plus,
  Edit2,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Sparkles,
  ArrowRight,
  RefreshCw,
  GitFork,
  Sliders,
  Play,
  Volume2,
  Users,
  Layers,
  Phone,
  HelpCircle,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/providers/AuthProvider';

export interface IvrOption {
  id?: string;
  digit: string;
  destinationType: 'user' | 'ivr' | 'voicemail' | 'call_queue' | 'hangup';
  destinationId: string | null;
  enabled?: boolean;
}

export interface IvrMenu {
  id: string;
  organizationId: string;
  name: string;
  enabled: boolean;
  greetingType: 'tts' | 'audio_url';
  greetingText: string;
  greetingAudioUrl: string | null;
  timeoutSeconds: number;
  maxRetries: number;
  timeoutDestinationType: 'user' | 'ivr' | 'voicemail' | 'call_queue' | 'hangup';
  timeoutDestinationId: string | null;
  fallbackDestinationType: 'user' | 'ivr' | 'voicemail' | 'call_queue' | 'hangup';
  fallbackDestinationId: string | null;
  createdAt: string;
  updatedAt: string;
  options?: IvrOption[];
}

export interface OrgPhoneNumber {
  id: string;
  phoneNumber: string;
  active: boolean;
  status: string;
  inboundRoutingType?: string;
  inboundRoutingDestinationId?: string | null;
}

export interface OrgUser {
  id: string;
  fullName: string;
  email: string;
  role: string;
  active: boolean;
}

export interface OrgQueue {
  id: string;
  name: string;
  enabled: boolean;
}

export function IvrSettings() {
  const router = useRouter();
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'owner' || profile?.role === 'admin';

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [entitled, setEntitled] = useState<boolean>(false);
  const [callQueueEntitled, setCallQueueEntitled] = useState<boolean>(false);
  const [menus, setMenus] = useState<IvrMenu[]>([]);
  const [phoneNumbers, setPhoneNumbers] = useState<OrgPhoneNumber[]>([]);
  const [orgUsers, setOrgUsers] = useState<OrgUser[]>([]);
  const [orgQueues, setOrgQueues] = useState<OrgQueue[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [activeStep, setActiveStep] = useState<number>(1);
  const [editingMenuId, setEditingMenuId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  // Preview Modal State
  const [previewMenu, setPreviewMenu] = useState<IvrMenu | null>(null);

  // Form State
  const [formData, setFormData] = useState<{
    name: string;
    greetingType: 'tts' | 'audio_url';
    greetingText: string;
    greetingAudioUrl: string;
    timeoutSeconds: number;
    maxRetries: number;
    timeoutDestinationType: 'user' | 'ivr' | 'voicemail' | 'call_queue' | 'hangup';
    timeoutDestinationId: string;
    fallbackDestinationType: 'user' | 'ivr' | 'voicemail' | 'call_queue' | 'hangup';
    fallbackDestinationId: string;
    assignedPhoneId: string;
    enabled: boolean;
    options: IvrOption[];
  }>({
    name: 'Main Business Menu',
    greetingType: 'tts',
    greetingText: 'Thank you for calling Acme. Press 1 for Sales. Press 2 for Support. Press 0 for Reception.',
    greetingAudioUrl: '',
    timeoutSeconds: 5,
    maxRetries: 3,
    timeoutDestinationType: 'user',
    timeoutDestinationId: '',
    fallbackDestinationType: 'user',
    fallbackDestinationId: '',
    assignedPhoneId: '',
    enabled: true,
    options: [
      { digit: '1', destinationType: 'user', destinationId: '' },
      { digit: '2', destinationType: 'user', destinationId: '' },
      { digit: '0', destinationType: 'user', destinationId: '' },
    ],
  });

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      // 1. Fetch IVR Menus & entitlement
      const ivrRes = await fetch('/api/ivr');
      if (ivrRes.ok) {
        const data = await ivrRes.json();
        setEntitled(Boolean(data.entitled));
        setMenus(data.menus || []);
      } else if (ivrRes.status === 403) {
        setEntitled(false);
      }

      // 2. Fetch Phone Numbers
      const numRes = await fetch('/api/phone-numbers');
      if (numRes.ok) {
        const nData = await numRes.json();
        const rawList = nData.phoneNumbers || nData.numbers || [];
        setPhoneNumbers(
          rawList.map((n: any) => ({
            id: n.id,
            phoneNumber: n.phone_number || n.phoneNumber,
            active: n.active !== false && n.status === 'active',
            status: n.status || 'active',
            inboundRoutingType: n.inbound_routing_type || n.inboundRoutingType,
            inboundRoutingDestinationId: n.inbound_routing_destination_id || n.inboundRoutingDestinationId,
          }))
        );
      }

      // 3. Fetch Org Users
      const uRes = await fetch('/api/users');
      if (uRes.ok) {
        const uData = await uRes.json();
        const rawUsers = uData.users || uData.members || [];
        setOrgUsers(
          rawUsers.map((u: any) => ({
            id: u.id,
            fullName: u.full_name || u.email || 'Team Member',
            email: u.email,
            role: u.role || 'member',
            active: u.active !== false,
          }))
        );
      }

      // 4. Fetch Call Queues (if available)
      const qRes = await fetch('/api/queues');
      if (qRes.ok) {
        const qData = await qRes.json();
        setCallQueueEntitled(qData.entitled !== false);
        setOrgQueues(qData.queues || []);
      } else {
        setCallQueueEntitled(false);
      }
    } catch (err: any) {
      console.error('[IvrSettings] Error loading data:', err);
      setErrorMessage('Failed to load IVR configuration details.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const openCreateModal = () => {
    setEditingMenuId(null);
    setFormData({
      name: 'Main Business Menu',
      greetingType: 'tts',
      greetingText: 'Thank you for calling Acme. Press 1 for Sales. Press 2 for Support. Press 0 for Reception.',
      greetingAudioUrl: '',
      timeoutSeconds: 5,
      maxRetries: 3,
      timeoutDestinationType: 'user',
      timeoutDestinationId: orgUsers[0]?.id || '',
      fallbackDestinationType: 'user',
      fallbackDestinationId: orgUsers[0]?.id || '',
      assignedPhoneId: '',
      enabled: true,
      options: [
        { digit: '1', destinationType: callQueueEntitled && orgQueues[0] ? 'call_queue' : 'user', destinationId: callQueueEntitled && orgQueues[0] ? orgQueues[0].id : (orgUsers[0]?.id || '') },
        { digit: '2', destinationType: 'user', destinationId: orgUsers[0]?.id || '' },
        { digit: '0', destinationType: 'user', destinationId: orgUsers[0]?.id || '' },
      ],
    });
    setActiveStep(1);
    setIsModalOpen(true);
  };

  const openEditModal = (menu: IvrMenu) => {
    setEditingMenuId(menu.id);
    const assignedNum = phoneNumbers.find(
      (p) => p.inboundRoutingType === 'ivr' && p.inboundRoutingDestinationId === menu.id
    );

    setFormData({
      name: menu.name,
      greetingType: menu.greetingType || 'tts',
      greetingText: menu.greetingText || '',
      greetingAudioUrl: menu.greetingAudioUrl || '',
      timeoutSeconds: menu.timeoutSeconds || 5,
      maxRetries: menu.maxRetries || 3,
      timeoutDestinationType: menu.timeoutDestinationType || 'user',
      timeoutDestinationId: menu.timeoutDestinationId || '',
      fallbackDestinationType: menu.fallbackDestinationType || 'user',
      fallbackDestinationId: menu.fallbackDestinationId || '',
      assignedPhoneId: assignedNum?.id || '',
      enabled: menu.enabled,
      options: (menu.options || []).map((o) => ({
        id: o.id,
        digit: o.digit,
        destinationType: o.destinationType,
        destinationId: o.destinationId || '',
      })),
    });
    setActiveStep(1);
    setIsModalOpen(true);
  };

  const handleAddOption = () => {
    const existingDigits = formData.options.map((o) => o.digit);
    const availableDigits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#'].filter(
      (d) => !existingDigits.includes(d)
    );
    if (availableDigits.length === 0) return;

    setFormData((prev) => ({
      ...prev,
      options: [
        ...prev.options,
        {
          digit: availableDigits[0],
          destinationType: 'user',
          destinationId: orgUsers[0]?.id || '',
        },
      ],
    }));
  };

  const handleRemoveOption = (index: number) => {
    setFormData((prev) => ({
      ...prev,
      options: prev.options.filter((_, i) => i !== index),
    }));
  };

  const handleUpdateOption = (index: number, key: keyof IvrOption, val: any) => {
    setFormData((prev) => {
      const updated = [...prev.options];
      updated[index] = { ...updated[index], [key]: val };
      return { ...prev, options: updated };
    });
  };

  const handleSaveIvr = async () => {
    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    // Sanitize greeting text to prevent XML/TwiML injection
    const sanitizedGreeting = formData.greetingText
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/["']/g, '');

    try {
      let menuId = editingMenuId;

      if (!menuId) {
        // Create new menu
        const res = await fetch('/api/ivr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: formData.name,
            greetingType: formData.greetingType,
            greetingText: sanitizedGreeting,
            greetingAudioUrl: formData.greetingAudioUrl || null,
            timeoutSeconds: formData.timeoutSeconds,
            maxRetries: formData.maxRetries,
            timeoutDestinationType: formData.timeoutDestinationType,
            timeoutDestinationId: formData.timeoutDestinationId || null,
            fallbackDestinationType: formData.fallbackDestinationType,
            fallbackDestinationId: formData.fallbackDestinationId || null,
          }),
        });

        const data = await res.json();
        if (!res.ok || !data.result?.success) {
          throw new Error(data.message || data.error || 'Failed to create IVR menu.');
        }
        menuId = data.result.menu.id;
      } else {
        // Update existing menu
        const res = await fetch(`/api/ivr/${menuId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: formData.name,
            enabled: formData.enabled,
            greetingType: formData.greetingType,
            greetingText: sanitizedGreeting,
            greetingAudioUrl: formData.greetingAudioUrl || null,
            timeoutSeconds: formData.timeoutSeconds,
            maxRetries: formData.maxRetries,
            timeoutDestinationType: formData.timeoutDestinationType,
            timeoutDestinationId: formData.timeoutDestinationId || null,
            fallbackDestinationType: formData.fallbackDestinationType,
            fallbackDestinationId: formData.fallbackDestinationId || null,
          }),
        });

        const data = await res.json();
        if (!res.ok || !data.result?.success) {
          throw new Error(data.message || data.error || 'Failed to update IVR menu.');
        }
      }

      // Save options
      if (menuId) {
        for (const opt of formData.options) {
          const optRes = await fetch(`/api/ivr/${menuId}/options`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              digit: opt.digit,
              destinationType: opt.destinationType,
              destinationId: opt.destinationId || null,
            }),
          });
          const optData = await optRes.json();
          if (!optRes.ok || !optData.result?.success) {
            throw new Error(optData.message || `Failed to save option ${opt.digit}`);
          }
        }
      }

      // Assign phone number if selected
      if (formData.assignedPhoneId && menuId) {
        const routeRes = await fetch(`/api/phone-numbers/${formData.assignedPhoneId}/routing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            routingType: 'ivr',
            destinationId: menuId,
          }),
        });
        const routeData = await routeRes.json();
        if (!routeRes.ok || !routeData.result?.success) {
          throw new Error(routeData.message || 'Failed to assign phone number to IVR.');
        }
      }

      setSuccessMessage(editingMenuId ? 'IVR menu updated successfully.' : 'IVR menu created successfully.');
      setIsModalOpen(false);
      await fetchData();
    } catch (err: any) {
      console.error('[handleSaveIvr] Error:', err);
      setErrorMessage(err.message || 'Error saving IVR configuration.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleEnable = async (menu: IvrMenu) => {
    try {
      const nextState = !menu.enabled;
      const res = await fetch(`/api/ivr/${menu.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextState }),
      });
      if (res.ok) {
        setSuccessMessage(`IVR Menu "${menu.name}" ${nextState ? 'enabled' : 'disabled'} successfully.`);
        await fetchData();
      }
    } catch (err) {
      console.error('Error toggling IVR status:', err);
    }
  };

  const getDestinationLabel = (type: string, id: string | null) => {
    if (type === 'user') {
      const u = orgUsers.find((user) => user.id === id);
      return u ? `User: ${u.fullName}` : 'User (Unassigned)';
    }
    if (type === 'call_queue') {
      const q = orgQueues.find((queue) => queue.id === id);
      return q ? `Queue: ${q.name}` : 'Call Queue';
    }
    if (type === 'ivr') {
      const m = menus.find((menu) => menu.id === id);
      return m ? `Sub-menu: ${m.name}` : 'Nested IVR';
    }
    if (type === 'voicemail') return 'Voicemail Box';
    if (type === 'hangup') return 'Hang Up Call';
    return 'Default Fallback';
  };

  if (isLoading) {
    return (
      <div className="p-12 text-center text-xs text-slate-500 dark:text-slate-400">
        <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-blue-500" />
        <span>Loading IVR phone system state...</span>
      </div>
    );
  }

  // STARTER PLAN — LOCKED EXPERIENCE
  if (!entitled) {
    return (
      <div className="space-y-6 max-w-4xl mx-auto">
        <Card className="border-amber-200 dark:border-amber-900/60 bg-gradient-to-br from-white via-slate-50 to-amber-50/30 dark:from-slate-900 dark:via-slate-950 dark:to-amber-950/20 shadow-md">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                <GitFork className="w-5 h-5 text-amber-500" />
                <span>Interactive Voice Response (IVR) Phone Menu</span>
              </CardTitle>
              <Badge variant="amber" size="sm" className="font-bold flex items-center gap-1">
                <Lock className="w-3 h-3" />
                AVAILABLE ON PRO
              </Badge>
            </div>
          </CardHeader>

          <div className="space-y-6">
            <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-200 dark:border-amber-800/60 text-slate-800 dark:text-slate-200 text-xs leading-relaxed">
              <p className="font-semibold text-slate-900 dark:text-slate-100 mb-1">
                Create an automated phone menu and route callers to the right person or destination.
              </p>
              <p className="text-slate-600 dark:text-slate-400">
                IVR menu trees allow your business to present professional greetings, collect DTMF keypress input (e.g. Press 1 for Sales, Press 2 for Support), and direct incoming phone calls to agents or queue systems automatically.
              </p>
            </div>

            {/* Feature Highlights Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-start gap-3">
                <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-400 shrink-0">
                  <GitFork className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100">Multi-Level Menu Trees</h4>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Custom DTMF keypress paths (0-9, *, #) with nested sub-menus.</p>
                </div>
              </div>

              <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-start gap-3">
                <div className="p-2 rounded-lg bg-emerald-100 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400 shrink-0">
                  <Volume2 className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100">TTS & Audio Greetings</h4>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">High-quality Text-To-Speech prompts and custom audio welcome messages.</p>
                </div>
              </div>

              <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-start gap-3">
                <div className="p-2 rounded-lg bg-purple-100 dark:bg-purple-950 text-purple-600 dark:text-purple-400 shrink-0">
                  <Users className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100">Call Queue & Team Routing</h4>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Direct callers straight into multi-agent queues or specific team members.</p>
                </div>
              </div>

              <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-start gap-3">
                <div className="p-2 rounded-lg bg-rose-100 dark:bg-rose-950 text-rose-600 dark:text-rose-400 shrink-0">
                  <Sliders className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100">Timeout & Fallback Protection</h4>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Automatic retries and fallback destinations if callers make no selection.</p>
                </div>
              </div>
            </div>

            {/* Upgrade CTA Section */}
            <div className="p-5 rounded-2xl bg-gradient-to-r from-blue-900/40 via-indigo-900/40 to-slate-900 border border-blue-500/30 flex flex-col sm:flex-row items-center justify-between gap-4 text-white">
              <div className="space-y-1 text-center sm:text-left">
                <p className="text-sm font-bold flex items-center justify-center sm:justify-start gap-2">
                  <Sparkles className="w-4 h-4 text-amber-400" />
                  <span>Unlock IVR & Call Queues on the Pro Plan</span>
                </p>
                <p className="text-xs text-slate-300">
                  Upgrade your workspace subscription to enable IVR phone menus, advanced call queues, and up to 20 seats.
                </p>
              </div>
              <Button
                variant="primary"
                size="md"
                onClick={() => router.push('/settings/billing')}
                className="shrink-0 bg-blue-600 hover:bg-blue-500 text-white font-bold px-5"
              >
                <span>Upgrade to Pro</span>
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  // PRO / BUSINESS PLAN — FULL IVR MANAGEMENT EXPERIENCE
  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <GitFork className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <span>IVR Phone Menu Management</span>
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Configure automated auto-attendant menus, DTMF options, and phone number routing assignments.
          </p>
        </div>

        {isAdmin && (
          <Button
            variant="primary"
            size="sm"
            onClick={openCreateModal}
            className="flex items-center gap-2 shrink-0 font-bold"
          >
            <Plus className="w-4 h-4" />
            <span>Create IVR Menu</span>
          </Button>
        )}
      </div>

      {/* Status Notifications */}
      {successMessage && (
        <div className="p-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/80 border border-emerald-200 dark:border-emerald-700 text-emerald-800 dark:text-emerald-200 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span>{successMessage}</span>
          </div>
          <button onClick={() => setSuccessMessage(null)} className="text-emerald-600 hover:text-emerald-800">✕</button>
        </div>
      )}

      {errorMessage && (
        <div className="p-3.5 rounded-xl bg-rose-50 dark:bg-rose-950/80 border border-rose-200 dark:border-rose-700 text-rose-800 dark:text-rose-200 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button onClick={() => setErrorMessage(null)} className="text-rose-600 hover:text-rose-800">✕</button>
        </div>
      )}

      {/* IVR List Section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Layers className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <span>Configured IVR Menus ({menus.length})</span>
          </CardTitle>
        </CardHeader>

        {menus.length === 0 ? (
          <div className="p-12 text-center text-xs text-slate-500 space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-center mx-auto text-slate-500">
              <GitFork className="w-6 h-6 text-blue-500" />
            </div>
            <p className="text-slate-800 dark:text-slate-200 font-bold">No IVR Menus Created Yet</p>
            <p className="text-slate-500 max-w-sm mx-auto">
              Create an automated phone menu to route callers to your sales team, support queue, or specific team members.
            </p>
            {isAdmin && (
              <Button variant="primary" size="sm" onClick={openCreateModal} className="mt-2">
                <Plus className="w-4 h-4 mr-1.5" />
                <span>Create Your First IVR Menu</span>
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {menus.map((menu) => {
              const assignedNum = phoneNumbers.find(
                (p) => p.inboundRoutingType === 'ivr' && p.inboundRoutingDestinationId === menu.id
              );
              const optionCount = (menu.options || []).length;

              let statusBadge = (
                <Badge variant="neutral" size="sm">
                  NOT ASSIGNED
                </Badge>
              );

              if (menu.enabled && assignedNum) {
                statusBadge = (
                  <Badge variant="emerald" size="sm" className="flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" />
                    ENABLED — ASSIGNED TO {assignedNum.phoneNumber}
                  </Badge>
                );
              } else if (!menu.enabled) {
                statusBadge = (
                  <Badge variant="neutral" size="sm">
                    DISABLED
                  </Badge>
                );
              } else if (menu.enabled && !assignedNum) {
                statusBadge = (
                  <Badge variant="amber" size="sm">
                    ENABLED — NO NUMBER ASSIGNED
                  </Badge>
                );
              }

              return (
                <div
                  key={menu.id}
                  className="p-5 rounded-2xl bg-slate-50 dark:bg-slate-950/80 border border-slate-200 dark:border-slate-800 space-y-4 hover:border-slate-300 dark:hover:border-slate-700 transition-colors"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
                    <div>
                      <div className="flex items-center gap-2.5">
                        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">{menu.name}</h3>
                        {statusBadge}
                      </div>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 italic">
                        &quot;{menu.greetingText}&quot;
                      </p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPreviewMenu(menu)}
                        className="text-xs flex items-center gap-1.5"
                      >
                        <Play className="w-3.5 h-3.5 text-blue-500" />
                        <span>Flow Preview</span>
                      </Button>

                      {isAdmin && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openEditModal(menu)}
                            className="text-xs flex items-center gap-1.5"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                            <span>Edit</span>
                          </Button>

                          <button
                            onClick={() => handleToggleEnable(menu)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all border ${
                              menu.enabled
                                ? 'bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-200 border-amber-300'
                                : 'bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-200 border-emerald-300'
                            }`}
                          >
                            {menu.enabled ? 'Disable' : 'Enable'}
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Details Grid */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
                    <div>
                      <span className="text-[10px] uppercase font-bold text-slate-400 block mb-1">Assigned Number</span>
                      {assignedNum ? (
                        <span className="font-mono text-slate-900 dark:text-slate-200 font-bold flex items-center gap-1.5">
                          <Phone className="w-3.5 h-3.5 text-emerald-500" />
                          {assignedNum.phoneNumber}
                        </span>
                      ) : (
                        <span className="text-slate-400 italic">None assigned</span>
                      )}
                    </div>

                    <div>
                      <span className="text-[10px] uppercase font-bold text-slate-400 block mb-1">Configured DTMF Keys</span>
                      <span className="text-slate-900 dark:text-slate-200 font-semibold">
                        {optionCount} DTMF Option{optionCount === 1 ? '' : 's'}
                      </span>
                    </div>

                    <div>
                      <span className="text-[10px] uppercase font-bold text-slate-400 block mb-1">Fallback Destination</span>
                      <span className="text-slate-900 dark:text-slate-200 truncate block">
                        {getDestinationLabel(menu.fallbackDestinationType, menu.fallbackDestinationId)}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* CREATE / EDIT IVR SETUP MODAL */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-2xl w-full p-6 shadow-2xl space-y-6 my-8">
            {/* Modal Header & Progress */}
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-4">
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                  <GitFork className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                  <span>{editingMenuId ? 'Edit IVR Phone Menu' : 'Create IVR Phone Menu'}</span>
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Step {activeStep} of 7: {
                    activeStep === 1 ? 'IVR Name' :
                    activeStep === 2 ? 'Greeting Prompt' :
                    activeStep === 3 ? 'DTMF Options' :
                    activeStep === 4 ? 'Timeout & Fallback' :
                    activeStep === 5 ? 'Assign Phone Number' :
                    activeStep === 6 ? 'Call Flow Review' : 'Enable & Confirm'
                  }
                </p>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-lg font-bold"
              >
                ✕
              </button>
            </div>

            {/* Step Progress Bar */}
            <div className="flex items-center gap-1.5">
              {[1, 2, 3, 4, 5, 6, 7].map((s) => (
                <div
                  key={s}
                  className={`h-1.5 flex-1 rounded-full transition-all ${
                    s === activeStep
                      ? 'bg-blue-600 dark:bg-blue-400'
                      : s < activeStep
                      ? 'bg-emerald-500'
                      : 'bg-slate-200 dark:bg-slate-800'
                  }`}
                />
              ))}
            </div>

            {/* STEP 1 — CREATE / NAME */}
            {activeStep === 1 && (
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-bold text-slate-800 dark:text-slate-200 block mb-1.5">
                    IVR Menu Name
                  </label>
                  <Input
                    placeholder="e.g. Main Business Menu"
                    value={formData.name}
                    onChange={(e) => setFormData((p) => ({ ...p, name: e.target.value }))}
                  />
                  <p className="text-[11px] text-slate-500 mt-1">
                    Give this phone menu a friendly descriptive name for administrative reference.
                  </p>
                </div>
              </div>
            )}

            {/* STEP 2 — GREETING */}
            {activeStep === 2 && (
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-bold text-slate-800 dark:text-slate-200 block mb-1.5">
                    Greeting Prompt Type
                  </label>
                  <select
                    value={formData.greetingType}
                    onChange={(e) => setFormData((p) => ({ ...p, greetingType: e.target.value as any }))}
                    className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-slate-100 p-2.5 outline-none"
                  >
                    <option value="tts">Text-To-Speech (TTS)</option>
                    <option value="audio_url">Audio URL Broadcast</option>
                  </select>
                </div>

                {formData.greetingType === 'tts' ? (
                  <div>
                    <label className="text-xs font-bold text-slate-800 dark:text-slate-200 block mb-1.5">
                      Text-To-Speech Greeting Prompt
                    </label>
                    <textarea
                      rows={4}
                      value={formData.greetingText}
                      onChange={(e) => setFormData((p) => ({ ...p, greetingText: e.target.value }))}
                      className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-slate-100 p-3 outline-none focus:border-blue-500"
                      placeholder="Thank you for calling..."
                    />
                    <p className="text-[11px] text-slate-500 mt-1">
                      This text will be spoken to the caller when they dial your business number.
                    </p>
                  </div>
                ) : (
                  <div>
                    <label className="text-xs font-bold text-slate-800 dark:text-slate-200 block mb-1.5">
                      Greeting Audio File URL (.mp3 / .wav)
                    </label>
                    <Input
                      placeholder="https://example.com/audio/greeting.mp3"
                      value={formData.greetingAudioUrl}
                      onChange={(e) => setFormData((p) => ({ ...p, greetingAudioUrl: e.target.value }))}
                    />
                  </div>
                )}
              </div>
            )}

            {/* STEP 3 — MENU OPTIONS */}
            {activeStep === 3 && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-800 dark:text-slate-200">
                    DTMF Keypress Options ({formData.options.length})
                  </span>
                  <Button variant="outline" size="sm" onClick={handleAddOption} className="text-xs flex items-center gap-1">
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Key Option</span>
                  </Button>
                </div>

                <div className="space-y-3 max-h-60 overflow-y-auto pr-1">
                  {formData.options.map((opt, idx) => (
                    <div
                      key={idx}
                      className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 flex items-center gap-3"
                    >
                      <div className="w-16">
                        <label className="text-[10px] font-bold text-slate-400 block mb-1">Keypress</label>
                        <select
                          value={opt.digit}
                          onChange={(e) => handleUpdateOption(idx, 'digit', e.target.value)}
                          className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs p-1.5 font-mono font-bold"
                        >
                          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#'].map((d) => (
                            <option key={d} value={d}>
                              Press {d}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="flex-1">
                        <label className="text-[10px] font-bold text-slate-400 block mb-1">Destination Type</label>
                        <select
                          value={opt.destinationType}
                          onChange={(e) => handleUpdateOption(idx, 'destinationType', e.target.value)}
                          className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs p-1.5"
                        >
                          <option value="user">User / Team Member</option>
                          {callQueueEntitled && <option value="call_queue">Call Queue</option>}
                          <option value="voicemail">Voicemail</option>
                          <option value="hangup">Hang Up</option>
                        </select>
                      </div>

                      {opt.destinationType === 'user' && (
                        <div className="flex-1">
                          <label className="text-[10px] font-bold text-slate-400 block mb-1">Target User</label>
                          <select
                            value={opt.destinationId || ''}
                            onChange={(e) => handleUpdateOption(idx, 'destinationId', e.target.value)}
                            className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs p-1.5"
                          >
                            <option value="">Select User...</option>
                            {orgUsers.map((u) => (
                              <option key={u.id} value={u.id}>
                                {u.fullName}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      {opt.destinationType === 'call_queue' && callQueueEntitled && (
                        <div className="flex-1">
                          <label className="text-[10px] font-bold text-slate-400 block mb-1">Target Queue</label>
                          <select
                            value={opt.destinationId || ''}
                            onChange={(e) => handleUpdateOption(idx, 'destinationId', e.target.value)}
                            className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs p-1.5"
                          >
                            <option value="">Select Queue...</option>
                            {orgQueues.map((q) => (
                              <option key={q.id} value={q.id}>
                                {q.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      <button
                        onClick={() => handleRemoveOption(idx)}
                        className="text-slate-400 hover:text-rose-500 p-1.5 shrink-0 mt-4"
                        title="Remove Option"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* STEP 4 — NO INPUT / INVALID INPUT */}
            {activeStep === 4 && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-bold text-slate-800 dark:text-slate-200 block mb-1.5">
                      Timeout Duration (Seconds)
                    </label>
                    <Input
                      type="number"
                      min={1}
                      max={30}
                      value={formData.timeoutSeconds}
                      onChange={(e) => setFormData((p) => ({ ...p, timeoutSeconds: Number(e.target.value) }))}
                    />
                  </div>

                  <div>
                    <label className="text-xs font-bold text-slate-800 dark:text-slate-200 block mb-1.5">
                      Max Retry Attempts
                    </label>
                    <Input
                      type="number"
                      min={1}
                      max={10}
                      value={formData.maxRetries}
                      onChange={(e) => setFormData((p) => ({ ...p, maxRetries: Number(e.target.value) }))}
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs font-bold text-slate-800 dark:text-slate-200 block mb-1.5">
                    If caller enters no key / times out:
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <select
                      value={formData.timeoutDestinationType}
                      onChange={(e) => setFormData((p) => ({ ...p, timeoutDestinationType: e.target.value as any }))}
                      className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs p-2.5 outline-none"
                    >
                      <option value="user font-semibold">User / Team Member</option>
                      {callQueueEntitled && <option value="call_queue">Call Queue</option>}
                      <option value="voicemail">Voicemail Box</option>
                      <option value="hangup">Hang Up</option>
                    </select>

                    {formData.timeoutDestinationType === 'user' && (
                      <select
                        value={formData.timeoutDestinationId}
                        onChange={(e) => setFormData((p) => ({ ...p, timeoutDestinationId: e.target.value }))}
                        className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs p-2.5 outline-none"
                      >
                        <option value="">Select User...</option>
                        {orgUsers.map((u) => (
                          <option key={u.id} value={u.id}>{u.fullName}</option>
                        ))}
                      </select>
                    )}

                    {formData.timeoutDestinationType === 'call_queue' && callQueueEntitled && (
                      <select
                        value={formData.timeoutDestinationId}
                        onChange={(e) => setFormData((p) => ({ ...p, timeoutDestinationId: e.target.value }))}
                        className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs p-2.5 outline-none"
                      >
                        <option value="">Select Queue...</option>
                        {orgQueues.map((q) => (
                          <option key={q.id} value={q.id}>{q.name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>

                <div>
                  <label className="text-xs font-bold text-slate-800 dark:text-slate-200 block mb-1.5">
                    If caller enters invalid option / max retries reached:
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <select
                      value={formData.fallbackDestinationType}
                      onChange={(e) => setFormData((p) => ({ ...p, fallbackDestinationType: e.target.value as any }))}
                      className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs p-2.5 outline-none"
                    >
                      <option value="user">User / Team Member</option>
                      {callQueueEntitled && <option value="call_queue">Call Queue</option>}
                      <option value="voicemail">Voicemail Box</option>
                      <option value="hangup">Hang Up</option>
                    </select>

                    {formData.fallbackDestinationType === 'user' && (
                      <select
                        value={formData.fallbackDestinationId}
                        onChange={(e) => setFormData((p) => ({ ...p, fallbackDestinationId: e.target.value }))}
                        className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs p-2.5 outline-none"
                      >
                        <option value="">Select User...</option>
                        {orgUsers.map((u) => (
                          <option key={u.id} value={u.id}>{u.fullName}</option>
                        ))}
                      </select>
                    )}

                    {formData.fallbackDestinationType === 'call_queue' && callQueueEntitled && (
                      <select
                        value={formData.fallbackDestinationId}
                        onChange={(e) => setFormData((p) => ({ ...p, fallbackDestinationId: e.target.value }))}
                        className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs p-2.5 outline-none"
                      >
                        <option value="">Select Queue...</option>
                        {orgQueues.map((q) => (
                          <option key={q.id} value={q.id}>{q.name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* STEP 5 — ASSIGN BUSINESS NUMBER */}
            {activeStep === 5 && (
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-bold text-slate-800 dark:text-slate-200 block mb-1.5">
                    Select Active Business Phone Number
                  </label>
                  <select
                    value={formData.assignedPhoneId}
                    onChange={(e) => setFormData((p) => ({ ...p, assignedPhoneId: e.target.value }))}
                    className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs font-mono font-bold text-slate-900 dark:text-slate-100 p-3 outline-none"
                  >
                    <option value="">Do Not Assign Number Yet</option>
                    {phoneNumbers
                      .filter((p) => p.active)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.phoneNumber} {p.inboundRoutingType ? `(Currently: ${p.inboundRoutingType})` : ''}
                        </option>
                      ))}
                  </select>
                </div>

                {formData.assignedPhoneId && (
                  <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-300 dark:border-amber-700/60 text-amber-800 dark:text-amber-200 text-xs flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-bold">Routing Assignment Alert</p>
                      <p className="text-[11px] mt-0.5">
                        Enabling this IVR menu will set the inbound routing for the selected phone number to this IVR menu. Callers to this number will enter the automated menu tree.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* STEP 6 — REVIEW */}
            {activeStep === 6 && (
              <div className="space-y-4">
                <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-3 text-xs">
                  <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-2">
                    <span className="font-bold text-slate-900 dark:text-slate-100">{formData.name}</span>
                    <Badge variant="blue" size="sm">READY TO ENABLE</Badge>
                  </div>

                  <div>
                    <span className="text-[10px] uppercase font-bold text-slate-400 block">Greeting Prompt</span>
                    <p className="italic text-slate-700 dark:text-slate-300 font-sans mt-0.5">
                      &quot;{formData.greetingText}&quot;
                    </p>
                  </div>

                  <div>
                    <span className="text-[10px] uppercase font-bold text-slate-400 block mb-1">Keypress Routes</span>
                    <div className="space-y-1 font-mono text-[11px]">
                      {formData.options.map((o) => (
                        <div key={o.digit} className="flex items-center gap-2">
                          <span className="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300 font-bold">
                            Press {o.digit}
                          </span>
                          <span>→ {getDestinationLabel(o.destinationType, o.destinationId)}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-200 dark:border-slate-800 grid grid-cols-2 gap-2">
                    <div>
                      <span className="text-[10px] uppercase font-bold text-slate-400 block">No Input Timeout</span>
                      <span>{formData.timeoutSeconds}s → {getDestinationLabel(formData.timeoutDestinationType, formData.timeoutDestinationId)}</span>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase font-bold text-slate-400 block">Fallback Destination</span>
                      <span>{getDestinationLabel(formData.fallbackDestinationType, formData.fallbackDestinationId)}</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* STEP 7 — CONFIRM & SAVE */}
            {activeStep === 7 && (
              <div className="space-y-4 text-center py-4">
                <div className="w-12 h-12 rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-600 flex items-center justify-center mx-auto">
                  <CheckCircle2 className="w-6 h-6" />
                </div>
                <h4 className="text-sm font-bold text-slate-900 dark:text-slate-100">Ready to Save & Enable IVR Menu</h4>
                <p className="text-xs text-slate-500 max-w-md mx-auto">
                  The server will validate Pro IVR entitlement, user authorization, and destination ownership before enabling this menu.
                </p>
              </div>
            )}

            {/* Modal Controls */}
            <div className="flex items-center justify-between border-t border-slate-200 dark:border-slate-800 pt-4">
              {activeStep > 1 ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setActiveStep((s) => s - 1)}
                  disabled={isSaving}
                >
                  Previous
                </Button>
              ) : (
                <div />
              )}

              {activeStep < 7 ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setActiveStep((s) => s + 1)}
                  className="font-bold"
                >
                  Next Step
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSaveIvr}
                  disabled={isSaving}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold"
                >
                  {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save & Enable IVR'}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* CALL FLOW PREVIEW MODAL */}
      {previewMenu && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                <Play className="w-4 h-4 text-blue-500" />
                <span>Call Flow Visualizer — {previewMenu.name}</span>
              </h3>
              <button onClick={() => setPreviewMenu(null)} className="text-slate-400 hover:text-slate-200 font-bold">✕</button>
            </div>

            <div className="space-y-3 font-mono text-xs p-4 rounded-xl bg-slate-950 text-slate-200">
              <div className="text-emerald-400 font-bold">Incoming Call</div>
              <div className="text-slate-500 ml-3">↓</div>
              <div className="text-blue-400 font-bold">{previewMenu.name}</div>
              <div className="text-slate-400 text-[11px] italic ml-3">&quot;{previewMenu.greetingText}&quot;</div>

              {(previewMenu.options || []).map((o) => (
                <div key={o.digit} className="ml-3 pl-2 border-l border-slate-800 flex items-center gap-2">
                  <span className="text-amber-400 font-bold">Press {o.digit}</span>
                  <span className="text-slate-400">→</span>
                  <span className="text-slate-100">{getDestinationLabel(o.destinationType, o.destinationId)}</span>
                </div>
              ))}

              <div className="ml-3 pt-2 text-slate-400 text-[11px]">
                Timeout / Fallback ({previewMenu.timeoutSeconds}s) → {getDestinationLabel(previewMenu.fallbackDestinationType, previewMenu.fallbackDestinationId)}
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <Button variant="outline" size="sm" onClick={() => setPreviewMenu(null)}>
                Close Preview
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
