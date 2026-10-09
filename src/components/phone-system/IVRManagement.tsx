'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  Sliders,
  Plus,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  GitFork,
  Volume2,
} from 'lucide-react';
import { useAuth } from '@/components/providers/AuthProvider';

export interface IvrMenuUI {
  id: string;
  name: string;
  enabled: boolean;
  greetingType: 'tts' | 'audio_url';
  greetingText: string;
  timeoutSeconds: number;
  maxRetries: number;
  timeoutDestinationType: string;
  fallbackDestinationType: string;
  options?: {
    id: string;
    digit: string;
    destinationType: string;
    destinationId: string | null;
    enabled: boolean;
  }[];
}

export function IVRManagement() {
  const { profile } = useAuth();
  const [menus, setMenus] = useState<IvrMenuUI[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isCreating, setIsCreating] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // New Menu Form State
  const [newMenuName, setNewMenuName] = useState<string>('');
  const [newGreetingText, setNewGreetingText] = useState<string>(
    'Thank you for calling. Press 1 for Sales, Press 2 for Support, or Press 0 for Voicemail.'
  );

  // New Option Form State
  const [newDigit, setNewDigit] = useState<string>('1');
  const [newDestType, setNewDestType] = useState<string>('user');

  const fetchMenus = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ivr', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setMenus(data.menus || []);
      } else {
        const errJson = await res.json().catch(() => ({}));
        setError(errJson.message || 'Failed to load Call Menus.');
      }
    } catch (err) {
      setError('Network error loading Call Menus.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMenus();
  }, [fetchMenus]);

  const handleCreateMenu = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (!newMenuName.trim()) {
      setError('Call Menu Name is required.');
      return;
    }

    try {
      const res = await fetch('/api/ivr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newMenuName.trim(),
          greetingText: newGreetingText.trim(),
        }),
      });

      const data = await res.json();
      if (res.ok && data.result?.success) {
        setSuccess('Call Menu created successfully!');
        setNewMenuName('');
        setIsCreating(false);
        fetchMenus();
      } else {
        setError(data.message || 'Failed to create Call Menu.');
      }
    } catch (err) {
      setError('Network error creating Call Menu.');
    }
  };

  const handleAddOption = async (menuId: string) => {
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch(`/api/ivr/${menuId}/options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          digit: newDigit,
          destinationType: newDestType,
        }),
      });

      const data = await res.json();
      if (res.ok && data.result?.success) {
        setSuccess(`Press ${newDigit} option added!`);
        fetchMenus();
      } else {
        setError(data.message || 'Failed to add option.');
      }
    } catch (err) {
      setError('Network error adding option.');
    }
  };

  const handleDeleteOption = async (menuId: string, optionId: string) => {
    try {
      const res = await fetch(`/api/ivr/${menuId}/options/${optionId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setSuccess('Option removed.');
        fetchMenus();
      }
    } catch (err) {
      setError('Failed to delete option.');
    }
  };

  const handleDeleteMenu = async (menuId: string) => {
    if (!confirm('Are you sure you want to disable this Call Menu?')) return;
    try {
      const res = await fetch(`/api/ivr/${menuId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setSuccess('Call Menu disabled.');
        fetchMenus();
      }
    } catch (err) {
      setError('Failed to disable menu.');
    }
  };

  const getActionLabel = (type: string) => {
    if (type === 'user') return 'Forward To';
    if (type === 'call_queue') return 'Send To Queue';
    if (type === 'ivr') return 'Send To IVR';
    if (type === 'voicemail') return 'Send To Voicemail';
    if (type === 'hangup') return 'End Call';
    return type;
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-16">
      {/* HEADER */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <GitFork className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <span>Call Menu (IVR)</span>
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Set up automated phone menus to greet callers and direct them to team members, queues, or voicemail.
          </p>
        </div>

        <Button
          onClick={() => setIsCreating(true)}
          variant="primary"
          className="text-xs flex items-center gap-1.5 shrink-0 font-bold"
        >
          <Plus className="w-4 h-4" />
          <span>Create Call Menu</span>
        </Button>
      </div>

      {/* NOTIFICATIONS */}
      {error && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-900 dark:text-rose-200 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-900 dark:text-emerald-200 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      {/* CREATE NEW MENU MODAL */}
      {isCreating && (
        <Card className="border-blue-500/30 bg-blue-50/10 dark:bg-blue-950/10">
          <CardHeader>
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Sliders className="w-4 h-4 text-blue-500" />
              <span>Create New Call Menu (IVR)</span>
            </CardTitle>
          </CardHeader>
          <form onSubmit={handleCreateMenu} className="p-5 pt-0 space-y-4 text-xs">
            <div>
              <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Menu Name
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Main Reception"
                value={newMenuName}
                onChange={(e) => setNewMenuName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Greeting Message
              </label>
              <textarea
                rows={3}
                required
                value={newGreetingText}
                onChange={(e) => setNewGreetingText(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setIsCreating(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm" className="font-bold">
                Save Call Menu
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* MENU LIST */}
      {isLoading ? (
        <div className="p-12 text-center text-xs text-slate-500">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-blue-500" />
          <span>Loading Call Menus...</span>
        </div>
      ) : menus.length === 0 ? (
        <Card className="p-12 text-center text-xs text-slate-500 space-y-2">
          <p className="font-bold text-slate-800 dark:text-slate-200">No Call Menus Created Yet</p>
          <p>Create a Call Menu to route incoming calls to team members, queues, or voicemail.</p>
        </Card>
      ) : (
        <div className="space-y-4">
          {menus.map((menu) => (
            <Card key={menu.id} className="p-5 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">{menu.name}</h3>
                    {menu.enabled ? (
                      <Badge variant="emerald" size="sm">Active</Badge>
                    ) : (
                      <Badge variant="neutral" size="sm">Disabled</Badge>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 italic">&quot;{menu.greetingText}&quot;</p>
                </div>

                <Button variant="outline" size="sm" onClick={() => handleDeleteMenu(menu.id)} className="text-rose-500">
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>

              {/* OPTIONS LIST */}
              <div className="space-y-2 text-xs">
                <span className="font-bold text-slate-400 block uppercase text-[10px]">Menu Options</span>
                {(menu.options || []).length === 0 ? (
                  <p className="text-slate-400 italic">No menu options added yet.</p>
                ) : (
                  <div className="space-y-1">
                    {(menu.options || []).map((opt) => (
                      <div key={opt.id} className="flex items-center justify-between p-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                        <div className="flex items-center gap-2">
                          <span className="px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300 font-mono font-bold">
                            Press {opt.digit}
                          </span>
                          <span className="font-semibold text-slate-700 dark:text-slate-300">
                            → {getActionLabel(opt.destinationType)}
                          </span>
                        </div>
                        <button
                          onClick={() => handleDeleteOption(menu.id, opt.id)}
                          className="text-slate-400 hover:text-rose-500 text-xs font-bold"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* ADD OPTION INLINE */}
                <div className="pt-2 flex items-center gap-2">
                  <select
                    value={newDigit}
                    onChange={(e) => setNewDigit(e.target.value)}
                    className="px-2 py-1 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs font-mono font-bold"
                  >
                    {['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#'].map((k) => (
                      <option key={k} value={k}>Press {k}</option>
                    ))}
                  </select>

                  <select
                    value={newDestType}
                    onChange={(e) => setNewDestType(e.target.value)}
                    className="px-2 py-1 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs font-medium"
                  >
                    <option value="user">Forward To</option>
                    <option value="call_queue">Send To Queue</option>
                    <option value="ivr">Send To IVR</option>
                    <option value="voicemail">Send To Voicemail</option>
                  </select>

                  <Button variant="outline" size="sm" onClick={() => handleAddOption(menu.id)} className="text-xs font-bold">
                    Add Option
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
