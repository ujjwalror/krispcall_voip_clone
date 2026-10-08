'use client';

import React, { useState, useEffect } from 'react';

interface Queue {
  id: string;
  name: string;
  enabled: boolean;
  strategy: 'fifo' | 'round_robin' | 'longest_idle';
  maxWaitSeconds: number;
  ringTimeoutSeconds: number;
  greetingText: string;
  fallbackDestinationType: 'user' | 'ivr' | 'voicemail' | 'hangup';
  fallbackDestinationId: string | null;
  members?: Array<{
    id: string;
    userId: string;
    enabled: boolean;
    priority: number;
    profile?: {
      fullName: string | null;
      email: string | null;
    };
  }>;
}

interface TeamMember {
  id: string;
  full_name: string | null;
  email: string | null;
  role: string;
}

export function QueueManagement() {
  const [queues, setQueues] = useState<Queue[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingQueue, setEditingQueue] = useState<Queue | null>(null);

  // Form states
  const [name, setName] = useState('');
  const [strategy, setStrategy] = useState<'fifo' | 'round_robin' | 'longest_idle'>('fifo');
  const [maxWaitSeconds, setMaxWaitSeconds] = useState(300);
  const [ringTimeoutSeconds, setRingTimeoutSeconds] = useState(20);
  const [greetingText, setGreetingText] = useState('Thank you for calling. Please hold while we connect you to an agent.');
  const [fallbackDestinationType, setFallbackDestinationType] = useState<'user' | 'ivr' | 'voicemail' | 'hangup'>('voicemail');
  const [fallbackDestinationId, setFallbackDestinationId] = useState('');
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    setLoading(true);
    setError(null);
    try {
      const [qRes, tRes] = await Promise.all([
        fetch('/api/queues'),
        fetch('/api/users/presence'),
      ]);

      if (qRes.status === 403) {
        setError('Call Queue feature is not enabled for your subscription plan.');
        setLoading(false);
        return;
      }

      const qData = await qRes.json();
      const tData = await tRes.json();

      if (qRes.ok) {
        setQueues(qData.queues || []);
      } else {
        setError(qData.error || 'Failed to load queues.');
      }

      if (tRes.ok) {
        setTeamMembers(tData.team || []);
      }
    } catch (err: any) {
      setError(err.message || 'Error connecting to server.');
    } finally {
      setLoading(false);
    }
  }

  function openCreateModal() {
    setEditingQueue(null);
    setName('');
    setStrategy('fifo');
    setMaxWaitSeconds(300);
    setRingTimeoutSeconds(20);
    setGreetingText('Thank you for calling. Please hold while we connect you to an agent.');
    setFallbackDestinationType('voicemail');
    setFallbackDestinationId('');
    setSelectedAgentIds([]);
    setShowModal(true);
  }

  function openEditModal(q: Queue) {
    setEditingQueue(q);
    setName(q.name);
    setStrategy(q.strategy);
    setMaxWaitSeconds(q.maxWaitSeconds);
    setRingTimeoutSeconds(q.ringTimeoutSeconds);
    setGreetingText(q.greetingText);
    setFallbackDestinationType(q.fallbackDestinationType);
    setFallbackDestinationId(q.fallbackDestinationId || '');
    setSelectedAgentIds((q.members || []).map(m => m.userId));
    setShowModal(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    setSubmitting(true);
    try {
      const url = editingQueue ? `/api/queues/${editingQueue.id}` : '/api/queues';
      const method = editingQueue ? 'PATCH' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          strategy,
          maxWaitSeconds: Number(maxWaitSeconds),
          ringTimeoutSeconds: Number(ringTimeoutSeconds),
          greetingText: greetingText.trim(),
          fallbackDestinationType,
          fallbackDestinationId: fallbackDestinationId.trim() || null,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to save queue.');
        setSubmitting(false);
        return;
      }

      const savedQueueId = editingQueue ? editingQueue.id : data.queue?.id;

      // Sync members
      if (savedQueueId) {
        for (const agentId of selectedAgentIds) {
          await fetch(`/api/queues/${savedQueueId}/members`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: agentId, priority: 1 }),
          });
        }
      }

      setShowModal(false);
      fetchData();
    } catch (err: any) {
      alert(err.message || 'Failed to save queue.');
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleQueueStatus(q: Queue) {
    try {
      const res = await fetch(`/api/queues/${q.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !q.enabled }),
      });
      if (res.ok) {
        fetchData();
      }
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex justify-between items-center border-b pb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Call Queues</h1>
          <p className="text-sm text-gray-500">Configure inbound call queues and agent assignment policies</p>
        </div>
        <div className="flex gap-3">
          <a
            href="/settings/queues/dashboard"
            className="px-4 py-2 bg-indigo-50 border border-indigo-200 text-indigo-700 font-medium rounded-lg hover:bg-indigo-100"
          >
            📊 Live Queue Dashboard
          </a>
          <button
            onClick={openCreateModal}
            className="px-4 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 shadow-sm"
          >
            + Create Call Queue
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg text-sm">
          ⚠️ {error}
        </div>
      )}

      {loading ? (
        <div className="p-12 text-center text-gray-500">Loading call queues...</div>
      ) : queues.length === 0 ? (
        <div className="p-12 text-center border-2 border-dashed border-gray-200 rounded-xl">
          <p className="text-gray-500 font-medium">No call queues configured yet.</p>
          <button onClick={openCreateModal} className="mt-3 text-indigo-600 font-semibold hover:underline">
            Create your first call queue →
          </button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {queues.map((q) => (
            <div key={q.id} className="border rounded-xl p-5 bg-white shadow-sm space-y-3">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="font-bold text-lg text-gray-900">{q.name}</h3>
                  <span className="inline-block px-2 py-0.5 text-xs font-semibold rounded bg-slate-100 text-slate-700 uppercase mt-1">
                    Strategy: {q.strategy}
                  </span>
                </div>
                <button
                  onClick={() => toggleQueueStatus(q)}
                  className={`px-3 py-1 text-xs font-semibold rounded-full ${
                    q.enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                  }`}
                >
                  {q.enabled ? 'Active' : 'Disabled'}
                </button>
              </div>

              <div className="text-sm text-gray-600 space-y-1">
                <div>⏱️ Max Wait: <strong>{q.maxWaitSeconds}s</strong></div>
                <div>🔔 Ring Timeout: <strong>{q.ringTimeoutSeconds}s</strong></div>
                <div>👥 Assigned Agents: <strong>{q.members?.length || 0}</strong></div>
              </div>

              <div className="pt-3 border-t flex justify-end gap-2">
                <button
                  onClick={() => openEditModal(q)}
                  className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md font-medium"
                >
                  Edit Queue
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* CREATE / EDIT QUEUE MODAL */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-xl w-full p-6 shadow-xl space-y-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold text-gray-900">
              {editingQueue ? 'Edit Call Queue' : 'Create New Call Queue'}
            </h2>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">Queue Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Sales Inbound Queue"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1">Distribution Strategy</label>
                  <select
                    value={strategy}
                    onChange={(e) => setStrategy(e.target.value as any)}
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="fifo">FIFO (First-In, First-Out)</option>
                    <option value="longest_idle">Longest Idle Agent</option>
                    <option value="round_robin">Round Robin</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1">Max Wait (Seconds)</label>
                  <input
                    type="number"
                    min={10}
                    max={3600}
                    value={maxWaitSeconds}
                    onChange={(e) => setMaxWaitSeconds(Number(e.target.value))}
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">Agent Ring Timeout (Seconds)</label>
                <input
                  type="number"
                  min={5}
                  max={120}
                  value={ringTimeoutSeconds}
                  onChange={(e) => setRingTimeoutSeconds(Number(e.target.value))}
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">Hold Greeting Text</label>
                <textarea
                  rows={2}
                  value={greetingText}
                  onChange={(e) => setGreetingText(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">Fallback Destination</label>
                <select
                  value={fallbackDestinationType}
                  onChange={(e) => setFallbackDestinationType(e.target.value as any)}
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                >
                  <option value="voicemail">Voicemail</option>
                  <option value="user">Specific User / Extension</option>
                  <option value="ivr">IVR Menu</option>
                  <option value="hangup">Hangup</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">Assign Queue Agents</label>
                <div className="border rounded-lg p-3 max-h-40 overflow-y-auto space-y-2 bg-gray-50">
                  {teamMembers.map((m) => {
                    const isChecked = selectedAgentIds.includes(m.id);
                    return (
                      <label key={m.id} className="flex items-center gap-2 text-sm text-gray-800 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {
                            if (isChecked) {
                              setSelectedAgentIds(selectedAgentIds.filter(id => id !== m.id));
                            } else {
                              setSelectedAgentIds([...selectedAgentIds, m.id]);
                            }
                          }}
                          className="rounded text-indigo-600"
                        />
                        <span>{m.full_name || m.email} ({m.role})</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 border rounded-lg text-sm text-gray-600 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50"
                >
                  {submitting ? 'Saving...' : 'Save Queue'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
