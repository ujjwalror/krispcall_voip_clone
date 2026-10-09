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
  GitFork,
  Sliders,
  Play,
  Volume2,
  Users,
  Layers,
  Phone,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/providers/AuthProvider';

export interface IvrOption {
  id?: string;
  digit: string;
  destinationType: 'user' | 'ivr' | 'call_queue' | 'voicemail' | 'hangup';
  destinationId: string | null;
  unansweredStrategy?: 'voicemail' | 'hangup' | null;
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
  timeoutDestinationType: 'user' | 'ivr' | 'call_queue' | 'voicemail' | 'hangup';
  timeoutDestinationId: string | null;
  fallbackDestinationType: 'user' | 'ivr' | 'call_queue' | 'voicemail' | 'hangup';
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

const ALL_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#'];

export function IvrSettings() {
  const router = useRouter();
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'owner' || profile?.role === 'admin';

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [entitled, setEntitled] = useState<boolean>(false);
  const [callQueueEntitled, setCallQueueEntitled] = useState<boolean>(false);
  const [voicemailEntitled, setVoicemailEntitled] = useState<boolean>(false);
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
    timeoutDestinationType: 'user' | 'ivr' | 'call_queue' | 'voicemail' | 'hangup';
    timeoutDestinationId: string;
    fallbackDestinationType: 'user' | 'ivr' | 'call_queue' | 'voicemail' | 'hangup';
    fallbackDestinationId: string;
    assignedPhoneId: string;
    enabled: boolean;
    options: IvrOption[];
  }>({
    name: '',
    greetingType: 'tts',
    greetingText: '',
    greetingAudioUrl: '',
    timeoutSeconds: 5,
    maxRetries: 3,
    timeoutDestinationType: 'user',
    timeoutDestinationId: '',
    fallbackDestinationType: 'voicemail',
    fallbackDestinationId: '',
    assignedPhoneId: '',
    enabled: true,
    options: [],
  });

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      // 1. Fetch IVR Menus & entitlements
      const ivrRes = await fetch('/api/ivr');
      if (ivrRes.ok) {
        const data = await ivrRes.json();
        setEntitled(Boolean(data.entitled));
        if (typeof data.callQueueEntitled === 'boolean') {
          setCallQueueEntitled(data.callQueueEntitled);
        }
        if (typeof data.voicemailEntitled === 'boolean') {
          setVoicemailEntitled(data.voicemailEntitled);
        }
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
      let rawUsers: any[] = [];
      const uRes = await fetch('/api/users/manage');
      if (uRes.ok) {
        const uData = await uRes.json();
        rawUsers = uData.members || uData.users || [];
      } else {
        const pRes = await fetch('/api/users/presence');
        if (pRes.ok) {
          const pData = await pRes.json();
          rawUsers = pData.team || [];
        }
      }
      setOrgUsers(
        rawUsers
          .filter((u: any) => u && u.active !== false)
          .map((u: any) => ({
            id: u.id,
            fullName: u.full_name || u.email || 'Team Member',
            email: u.email,
            role: u.role || 'member',
            active: true,
          }))
      );

      // 4. Fetch Call Queues (fallback check)
      const qRes = await fetch('/api/queues');
      if (qRes.ok) {
        const qData = await qRes.json();
        if (qData.entitled !== undefined) {
          setCallQueueEntitled(Boolean(qData.entitled));
        }
        setOrgQueues(qData.queues || []);
      }

      // 5. Fetch Voicemail status (fallback check)
      const vmRes = await fetch('/api/voicemails');
      if (vmRes.ok) {
        setVoicemailEntitled(true);
      }
    } catch (err: any) {
      console.error('[IvrSettings] Error loading data:', err);
      setErrorMessage('Failed to load Call Menu configuration details.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const openCreateModal = () => {
    setEditingMenuId(null);
    const defaultUserId = orgUsers[0]?.id || '';
    setFormData({
      name: '',
      greetingType: 'tts',
      greetingText: 'Thank you for calling. Press 1 for Sales, Press 2 for Support, or Press 0 for Voicemail.',
      greetingAudioUrl: '',
      timeoutSeconds: 5,
      maxRetries: 3,
      timeoutDestinationType: 'user',
      timeoutDestinationId: defaultUserId,
      fallbackDestinationType: voicemailEntitled ? 'voicemail' : 'user',
      fallbackDestinationId: voicemailEntitled ? '' : defaultUserId,
      assignedPhoneId: '',
      enabled: true,
      options: [],
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
      timeoutDestinationType: (menu.timeoutDestinationType as any) || 'user',
      timeoutDestinationId: menu.timeoutDestinationId || '',
      fallbackDestinationType: (menu.fallbackDestinationType as any) || 'voicemail',
      fallbackDestinationId: menu.fallbackDestinationId || '',
      assignedPhoneId: assignedNum?.id || '',
      enabled: menu.enabled,
      options: (menu.options || []).map((o) => ({
        id: o.id,
        digit: o.digit,
        destinationType: o.destinationType,
        destinationId: o.destinationId || '',
        unansweredStrategy: o.unansweredStrategy || 'voicemail',
      })),
    });
    setActiveStep(1);
    setIsModalOpen(true);
  };

  const getAvailableKeysForIndex = (index: number) => {
    const usedByOthers = formData.options
      .filter((_, i) => i !== index)
      .map((o) => o.digit);
    return ALL_KEYS.filter((k) => !usedByOthers.includes(k));
  };

  const handleAddOption = () => {
    const usedKeys = formData.options.map((o) => o.digit);
    const availableKeys = ALL_KEYS.filter((k) => !usedKeys.includes(k));
    if (availableKeys.length === 0) return;

    setFormData((prev) => ({
      ...prev,
      options: [
        ...prev.options,
        {
          digit: availableKeys[0],
          destinationType: 'user',
          destinationId: orgUsers[0]?.id || '',
          unansweredStrategy: 'voicemail',
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
      const targetOpt = { ...updated[index], [key]: val };

      if (key === 'destinationType') {
        if (val === 'user') targetOpt.destinationId = orgUsers[0]?.id || '';
        else if (val === 'call_queue') targetOpt.destinationId = orgQueues[0]?.id || '';
        else if (val === 'ivr') targetOpt.destinationId = menus.find((m) => m.id !== editingMenuId)?.id || '';
        else targetOpt.destinationId = '';
      }

      updated[index] = targetOpt;
      return { ...prev, options: updated };
    });
  };

  const validateForm = (
    data: typeof formData,
    users: OrgUser[],
    queues: OrgQueue[],
    allMenus: IvrMenu[],
    currentMenuId: string | null
  ): { ready: boolean; errors: string[] } => {
    const errors: string[] = [];

    if (!data.name || !data.name.trim()) {
      errors.push('Call Menu Name is required.');
    }

    if (data.greetingType === 'tts' && (!data.greetingText || !data.greetingText.trim())) {
      errors.push('Greeting message is required.');
    }

    if (data.greetingType === 'audio_url' && (!data.greetingAudioUrl || !data.greetingAudioUrl.trim())) {
      errors.push('Greeting audio URL is required.');
    }

    const keysSeen = new Set<string>();
    for (let i = 0; i < data.options.length; i++) {
      const opt = data.options[i];
      if (!opt.digit) {
        errors.push(`Option ${i + 1}: Key selection is required.`);
      } else if (keysSeen.has(opt.digit)) {
        errors.push(`Press ${opt.digit} is already being used in this menu.`);
      } else {
        keysSeen.add(opt.digit);
      }

      if (opt.destinationType === 'user') {
        if (!opt.destinationId || !users.some((u) => u.id === opt.destinationId)) {
          errors.push(`Choose where callers should be sent for Press ${opt.digit || i + 1}.`);
        }
      } else if (opt.destinationType === 'call_queue') {
        if (!callQueueEntitled || !opt.destinationId || !queues.some((q) => q.id === opt.destinationId)) {
          errors.push(`Press ${opt.digit || i + 1} requires a valid Call Queue destination.`);
        }
      } else if (opt.destinationType === 'ivr') {
        if (!opt.destinationId || opt.destinationId === currentMenuId || !allMenus.some((m) => m.id === opt.destinationId)) {
          errors.push(`Press ${opt.digit || i + 1} requires a valid Call Menu destination.`);
        }
      } else if (opt.destinationType === 'voicemail') {
        if (!voicemailEntitled) {
          errors.push(`Voicemail is not enabled on your subscription plan for Press ${opt.digit || i + 1}.`);
        }
      } else if (opt.destinationType === 'hangup') {
        // Valid
      } else {
        errors.push(`Press ${opt.digit || i + 1} has an invalid action.`);
      }
    }

    return {
      ready: errors.length === 0,
      errors,
    };
  };

  const validationResult = validateForm(formData, orgUsers, orgQueues, menus, editingMenuId);

  const handleSaveIvr = async () => {
    if (!validationResult.ready) {
      setErrorMessage(validationResult.errors[0] || 'Configuration is incomplete.');
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

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
          throw new Error(data.message || data.error || 'Failed to create Call Menu.');
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
          throw new Error(data.message || data.error || 'Failed to update Call Menu.');
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
            throw new Error(optData.message || `Failed to save Press ${opt.digit}`);
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
          throw new Error(routeData.message || 'Failed to assign phone number to Call Menu.');
        }
      }

      setSuccessMessage(editingMenuId ? 'Call Menu updated successfully.' : 'Call Menu created successfully.');
      setIsModalOpen(false);
      await fetchData();
    } catch (err: any) {
      console.error('[handleSaveIvr] Error:', err);
      setErrorMessage(err.message || 'Error saving Call Menu configuration.');
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
        setSuccessMessage(`Call Menu "${menu.name}" ${nextState ? 'enabled' : 'disabled'} successfully.`);
        await fetchData();
      }
    } catch (err) {
      console.error('Error toggling Call Menu status:', err);
    }
  };

  const getDestinationLabel = (type: string, id: string | null) => {
    if (type === 'user') {
      const u = orgUsers.find((user) => user.id === id);
      return u ? `Forward To: ${u.fullName}` : 'Forward To: Team Member';
    }
    if (type === 'call_queue') {
      const q = orgQueues.find((queue) => queue.id === id);
      return q ? `Send To Queue: ${q.name}` : 'Send To Queue';
    }
    if (type === 'ivr') {
      const m = menus.find((menu) => menu.id === id);
      return m ? `Send To IVR: ${m.name}` : 'Send To Call Menu';
    }
    if (type === 'voicemail') return 'Send To Voicemail';
    if (type === 'hangup') return 'End Call';
    return 'Voicemail';
  };

  if (isLoading) {
    return (
      <div className="p-12 text-center text-xs text-slate-500 dark:text-slate-400">
        <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-blue-500" />
        <span>Loading Call Menu system...</span>
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
                <span>Call Menu (IVR)</span>
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
                Set up automated phone menus to greet callers and direct them to team members, queues, or voicemail.
              </p>
              <p className="text-slate-600 dark:text-slate-400">
                Call Menus (IVR) allow your business to present professional greetings, accept keypress options (e.g., Press 1 for Sales, Press 2 for Support), and direct incoming phone calls automatically.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-start gap-3">
                <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-400 shrink-0">
                  <GitFork className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100">Simple Key Options</h4>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Route callers with single key choices (Press 1, Press 2, Press 0).</p>
                </div>
              </div>

              <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-start gap-3">
                <div className="p-2 rounded-lg bg-emerald-100 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400 shrink-0">
                  <Volume2 className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100">Greetings & Prompts</h4>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Professional spoken greetings and audio welcome prompts.</p>
                </div>
              </div>

              <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-start gap-3">
                <div className="p-2 rounded-lg bg-purple-100 dark:bg-purple-950 text-purple-600 dark:text-purple-400 shrink-0">
                  <Users className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100">Team & Queue Forwarding</h4>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Direct callers straight to team members or support queues.</p>
                </div>
              </div>

              <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-start gap-3">
                <div className="p-2 rounded-lg bg-rose-100 dark:bg-rose-950 text-rose-600 dark:text-rose-400 shrink-0">
                  <Sliders className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100">Voicemail Integration</h4>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Seamless fallback to voicemail when team members are unavailable.</p>
                </div>
              </div>
            </div>

            <div className="p-5 rounded-2xl bg-gradient-to-r from-blue-900/40 via-indigo-900/40 to-slate-900 border border-blue-500/30 flex flex-col sm:flex-row items-center justify-between gap-4 text-white">
              <div className="space-y-1 text-center sm:text-left">
                <p className="text-sm font-bold flex items-center justify-center sm:justify-start gap-2">
                  <Sparkles className="w-4 h-4 text-amber-400" />
                  <span>Unlock Call Menus (IVR) on Pro</span>
                </p>
                <p className="text-xs text-slate-300">
                  Upgrade your workspace to enable Call Menus, call queues, and automated call distribution.
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

  // PRO PLAN — FULL CALL MENU EXPERIENCE
  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <GitFork className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <span>Call Menu (IVR)</span>
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Set up automated phone menus to greet callers and direct them to team members, queues, or voicemail.
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
            <span>Create Call Menu</span>
          </Button>
        )}
      </div>

      {/* Notifications */}
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

      {/* Call Menu List Section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Layers className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <span>Call Menus ({menus.length})</span>
          </CardTitle>
        </CardHeader>

        {menus.length === 0 ? (
          <div className="p-12 text-center text-xs text-slate-500 space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-center mx-auto text-slate-500">
              <GitFork className="w-6 h-6 text-blue-500" />
            </div>
            <p className="text-slate-800 dark:text-slate-200 font-bold">No Call Menus Created Yet</p>
            <p className="text-slate-500 max-w-sm mx-auto">
              Create an automated menu to route callers to your sales team, support queue, or voicemail.
            </p>
            {isAdmin && (
              <Button variant="primary" size="sm" onClick={openCreateModal} className="mt-2 font-bold">
                <Plus className="w-4 h-4 mr-1.5" />
                <span>Create Call Menu</span>
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {menus.map((menu) => {
              const assignedNum = phoneNumbers.find(
                (p) => p.inboundRoutingType === 'ivr' && p.inboundRoutingDestinationId === menu.id
              );
              const options = menu.options || [];

              return (
                <div
                  key={menu.id}
                  className="p-5 rounded-2xl bg-slate-50 dark:bg-slate-950/80 border border-slate-200 dark:border-slate-800 space-y-4 hover:border-slate-300 dark:hover:border-slate-700 transition-colors"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
                    <div>
                      <div className="flex items-center gap-2.5">
                        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">{menu.name}</h3>
                        {menu.enabled ? (
                          <Badge variant="emerald" size="sm">Active</Badge>
                        ) : (
                          <Badge variant="neutral" size="sm">Disabled</Badge>
                        )}
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
                        <span>Preview Flow</span>
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

                  {/* Option Summary & Number Status */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                    <div>
                      <span className="text-[10px] uppercase font-bold text-slate-400 block mb-1">Menu Options ({options.length})</span>
                      {options.length === 0 ? (
                        <span className="text-slate-400 italic">No options configured</span>
                      ) : (
                        <div className="space-y-1">
                          {options.map((o) => (
                            <div key={o.digit} className="flex items-center gap-2 text-[11px]">
                              <span className="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300 font-bold font-mono">
                                Press {o.digit}
                              </span>
                              <span className="text-slate-700 dark:text-slate-300 font-medium">
                                → {getDestinationLabel(o.destinationType, o.destinationId)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div>
                      <span className="text-[10px] uppercase font-bold text-slate-400 block mb-1">Phone Number Status</span>
                      {assignedNum ? (
                        <div className="space-y-0.5">
                          <span className="font-mono text-slate-900 dark:text-slate-200 font-bold flex items-center gap-1.5">
                            <Phone className="w-3.5 h-3.5 text-emerald-500" />
                            {assignedNum.phoneNumber}
                          </span>
                          <span className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium block">
                            Assigned &amp; Receiving Calls
                          </span>
                        </div>
                      ) : (
                        <span className="text-slate-400 italic text-[11px] block">
                          Not assigned to a phone number
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* CREATE / EDIT MODAL */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-2xl w-full p-6 shadow-2xl space-y-6 my-8">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-4">
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                  <GitFork className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                  <span>{editingMenuId ? 'Edit Call Menu (IVR)' : 'Create Call Menu (IVR)'}</span>
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Configure greeting message and press key routing options.
                </p>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-lg font-bold"
              >
                ✕
              </button>
            </div>

            {/* Form Content */}
            <div className="space-y-6">
              {/* Menu Name */}
              <div>
                <label className="text-xs font-bold text-slate-800 dark:text-slate-200 block mb-1">
                  Menu Name
                </label>
                <Input
                  placeholder="e.g. Main Reception"
                  value={formData.name}
                  onChange={(e) => setFormData((p) => ({ ...p, name: e.target.value }))}
                />
              </div>

              {/* Greeting Section */}
              <div className="space-y-3 p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                  <Volume2 className="w-4 h-4 text-blue-500" />
                  <span>Greeting</span>
                </h4>

                <div>
                  <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-400 block mb-1">
                    Greeting Type
                  </label>
                  <select
                    value={formData.greetingType}
                    onChange={(e) => setFormData((p) => ({ ...p, greetingType: e.target.value as any }))}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-xs p-2.5 outline-none font-medium"
                  >
                    <option value="tts">Text to Speech</option>
                    <option value="audio_url">Recorded Audio</option>
                  </select>
                </div>

                {formData.greetingType === 'tts' ? (
                  <div>
                    <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-400 block mb-1">
                      Message
                    </label>
                    <textarea
                      rows={3}
                      value={formData.greetingText}
                      onChange={(e) => setFormData((p) => ({ ...p, greetingText: e.target.value }))}
                      className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-slate-100 p-3 outline-none focus:border-blue-500"
                      placeholder="Thank you for calling. Press 1 for Sales, Press 2 for Support, or Press 0 for Voicemail."
                    />
                  </div>
                ) : (
                  <div>
                    <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-400 block mb-1">
                      Audio Recording URL (.mp3 / .wav)
                    </label>
                    <Input
                      placeholder="https://example.com/audio/greeting.mp3"
                      value={formData.greetingAudioUrl}
                      onChange={(e) => setFormData((p) => ({ ...p, greetingAudioUrl: e.target.value }))}
                    />
                  </div>
                )}
              </div>

              {/* Menu Options Section */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                    <Sliders className="w-4 h-4 text-blue-500" />
                    <span>Menu Options ({formData.options.length})</span>
                  </h4>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleAddOption}
                    className="text-xs font-bold flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Option</span>
                  </Button>
                </div>

                {formData.options.length === 0 ? (
                  <div className="p-6 text-center text-xs text-slate-500 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl">
                    No menu options configured. Click &quot;Add Option&quot; to define keypress choices for callers.
                  </div>
                ) : (
                  <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
                    {formData.options.map((opt, idx) => {
                      const availableKeys = getAvailableKeysForIndex(idx);
                      return (
                        <div
                          key={idx}
                          className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-3"
                        >
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-center">
                            {/* Key selection */}
                            <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Press</label>
                              <select
                                value={opt.digit}
                                onChange={(e) => handleUpdateOption(idx, 'digit', e.target.value)}
                                className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs p-2 font-mono font-bold"
                              >
                                {opt.digit && !availableKeys.includes(opt.digit) && (
                                  <option value={opt.digit}>Press {opt.digit}</option>
                                )}
                                {availableKeys.map((k) => (
                                  <option key={k} value={k}>
                                    Press {k}
                                  </option>
                                ))}
                              </select>
                            </div>

                            {/* Action selection */}
                            <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Action</label>
                              <select
                                value={opt.destinationType}
                                onChange={(e) => handleUpdateOption(idx, 'destinationType', e.target.value)}
                                className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs p-2 font-medium"
                              >
                                <option value="user">Forward To</option>
                                {callQueueEntitled && <option value="call_queue">Send To Queue</option>}
                                <option value="ivr">Send To IVR</option>
                                {voicemailEntitled && <option value="voicemail">Send To Voicemail</option>}
                              </select>
                            </div>

                            {/* Send To selection */}
                            <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Send To</label>
                              {opt.destinationType === 'user' && (
                                <select
                                  value={opt.destinationId || ''}
                                  onChange={(e) => handleUpdateOption(idx, 'destinationId', e.target.value)}
                                  className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs p-2 font-medium"
                                >
                                  <option value="">Select Team Member...</option>
                                  {orgUsers.map((u) => (
                                    <option key={u.id} value={u.id}>
                                      {u.fullName} ({u.role ? u.role.charAt(0).toUpperCase() + u.role.slice(1) : 'Member'})
                                    </option>
                                  ))}
                                </select>
                              )}

                              {opt.destinationType === 'call_queue' && (
                                <select
                                  value={opt.destinationId || ''}
                                  onChange={(e) => handleUpdateOption(idx, 'destinationId', e.target.value)}
                                  className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs p-2 font-medium"
                                >
                                  <option value="">Select Queue...</option>
                                  {orgQueues.length === 0 ? (
                                    <option value="" disabled>No call queues yet</option>
                                  ) : (
                                    orgQueues.map((q) => (
                                      <option key={q.id} value={q.id}>{q.name}</option>
                                    ))
                                  )}
                                </select>
                              )}

                              {opt.destinationType === 'ivr' && (
                                <select
                                  value={opt.destinationId || ''}
                                  onChange={(e) => handleUpdateOption(idx, 'destinationId', e.target.value)}
                                  className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs p-2 font-medium"
                                >
                                  <option value="">Select Call Menu...</option>
                                  {menus.filter((m) => m.id !== editingMenuId).length === 0 ? (
                                    <option value="" disabled>No other call menus</option>
                                  ) : (
                                    menus.filter((m) => m.id !== editingMenuId).map((m) => (
                                      <option key={m.id} value={m.id}>{m.name}</option>
                                    ))
                                  )}
                                </select>
                              )}

                              {opt.destinationType === 'voicemail' && (
                                <div className="text-xs text-slate-500 font-medium py-2">
                                  Voicemail Inbox
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Progressive Disclosure: If Unanswered for Forward To */}
                          <div className="flex items-center justify-between pt-2 border-t border-slate-200 dark:border-slate-800">
                            {opt.destinationType === 'user' ? (
                              <div className="flex items-center gap-2 text-xs">
                                <span className="text-[10px] font-bold text-slate-400 uppercase">If Unanswered:</span>
                                <select
                                  value={opt.unansweredStrategy || 'voicemail'}
                                  onChange={(e) => handleUpdateOption(idx, 'unansweredStrategy', e.target.value)}
                                  className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs p-1 font-medium"
                                >
                                  {voicemailEntitled && <option value="voicemail">Send To Voicemail</option>}
                                  <option value="hangup">End Call</option>
                                </select>
                              </div>
                            ) : (
                              <div />
                            )}

                            <button
                              onClick={() => handleRemoveOption(idx)}
                              className="text-slate-400 hover:text-rose-500 p-1 text-xs font-semibold flex items-center gap-1"
                              title="Remove Option"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              <span>Remove</span>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Phone Number Assignment */}
              <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2">
                <label className="text-xs font-bold text-slate-800 dark:text-slate-200 block">
                  Assign to Phone Number (Optional)
                </label>
                <select
                  value={formData.assignedPhoneId}
                  onChange={(e) => setFormData((p) => ({ ...p, assignedPhoneId: e.target.value }))}
                  className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-xs font-mono font-bold text-slate-900 dark:text-slate-100 p-2.5 outline-none"
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
                <p className="text-[11px] text-slate-500">
                  Call Menus can be created first and assigned to phone numbers later.
                </p>
              </div>

              {/* Validation Summary */}
              {!validationResult.ready && (
                <div className="p-3.5 rounded-xl bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200 text-xs space-y-1">
                  <p className="font-bold flex items-center gap-1.5">
                    <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />
                    <span>Please resolve the following before saving:</span>
                  </p>
                  <ul className="list-disc list-inside text-[11px] space-y-0.5">
                    {validationResult.errors.map((err, idx) => (
                      <li key={idx}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Modal Controls */}
            <div className="flex items-center justify-end gap-3 border-t border-slate-200 dark:border-slate-800 pt-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsModalOpen(false)}
                disabled={isSaving}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleSaveIvr}
                disabled={isSaving || !validationResult.ready}
                className="bg-blue-600 hover:bg-blue-500 text-white font-bold disabled:opacity-50"
              >
                {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save Call Menu'}
              </Button>
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
