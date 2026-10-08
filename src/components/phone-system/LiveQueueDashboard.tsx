'use client';

import React, { useState, useEffect } from 'react';
import { QueueDashboardMetrics } from '@/lib/telephony/queueService';

export function LiveQueueDashboard() {
  const [metrics, setMetrics] = useState<QueueDashboardMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchDashboard();
    const interval = setInterval(fetchDashboard, 3000); // 3-second auto refresh for live metrics
    return () => clearInterval(interval);
  }, []);

  async function fetchDashboard() {
    try {
      const res = await fetch('/api/queues/dashboard');
      if (res.status === 403) {
        setError('Call Queue feature is not enabled for your subscription plan.');
        setLoading(false);
        return;
      }
      const data = await res.json();
      if (res.ok) {
        setMetrics(data.metrics);
        setError(null);
      } else {
        setError(data.error || 'Failed to load dashboard metrics.');
      }
    } catch (err: any) {
      setError(err.message || 'Error connecting to server.');
    } finally {
      setLoading(false);
    }
  }

  function formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex justify-between items-center border-b pb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Live Call Queue Dashboard</h1>
          <p className="text-sm text-gray-500">Real-time operational monitoring for call queues and agent presence</p>
        </div>
        <div className="flex items-center gap-2 text-xs font-semibold text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-full border border-emerald-200">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          Live Metrics Active
        </div>
      </div>

      {error && (
        <div className="p-4 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg text-sm">
          ⚠️ {error}
        </div>
      )}

      {loading && !metrics ? (
        <div className="p-12 text-center text-gray-500">Loading Live Queue Dashboard...</div>
      ) : (
        <>
          {/* STAT CARDS */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
              <span className="text-xs font-semibold text-gray-500 uppercase">Waiting Callers</span>
              <div className="text-3xl font-extrabold text-amber-600 mt-1">{metrics?.waitingCallersCount || 0}</div>
            </div>

            <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
              <span className="text-xs font-semibold text-gray-500 uppercase">Active Calls</span>
              <div className="text-3xl font-extrabold text-indigo-600 mt-1">{metrics?.activeCallsCount || 0}</div>
            </div>

            <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
              <span className="text-xs font-semibold text-gray-500 uppercase">Available Agents</span>
              <div className="text-3xl font-extrabold text-emerald-600 mt-1">{metrics?.availableAgentsCount || 0}</div>
            </div>

            <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
              <span className="text-xs font-semibold text-gray-500 uppercase">Busy Agents</span>
              <div className="text-3xl font-extrabold text-blue-600 mt-1">{metrics?.busyAgentsCount || 0}</div>
            </div>

            <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
              <span className="text-xs font-semibold text-gray-500 uppercase">Longest Wait</span>
              <div className="text-3xl font-extrabold text-rose-600 mt-1">
                {formatTime(metrics?.longestWaitSeconds || 0)}
              </div>
            </div>

            <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
              <span className="text-xs font-semibold text-gray-500 uppercase">Abandoned Today</span>
              <div className="text-3xl font-extrabold text-slate-700 mt-1">{metrics?.abandonedTodayCount || 0}</div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* WAITING CALLERS TABLE */}
            <div className="lg:col-span-2 bg-white rounded-xl border shadow-sm p-5 space-y-4">
              <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                ⏳ Waiting Callers ({metrics?.waitingCallers.length || 0})
              </h2>

              {(!metrics?.waitingCallers || metrics.waitingCallers.length === 0) ? (
                <div className="py-8 text-center text-sm text-gray-500 border border-dashed rounded-lg">
                  No callers currently waiting in queue.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-gray-50 border-b text-gray-600 font-semibold">
                      <tr>
                        <th className="py-2.5 px-3">Caller</th>
                        <th className="py-2.5 px-3">Status</th>
                        <th className="py-2.5 px-3">Entered At</th>
                        <th className="py-2.5 px-3">Attempts</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {metrics.waitingCallers.map((c) => (
                        <tr key={c.id}>
                          <td className="py-2.5 px-3 font-medium text-gray-900">{c.callerPhoneNumber}</td>
                          <td className="py-2.5 px-3">
                            <span className="px-2 py-0.5 text-xs font-semibold bg-amber-100 text-amber-800 rounded">
                              WAITING
                            </span>
                          </td>
                          <td className="py-2.5 px-3 text-gray-600">{new Date(c.enteredAt).toLocaleTimeString()}</td>
                          <td className="py-2.5 px-3 text-gray-600">{c.attemptCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* ACTIVE CALLS TABLE */}
              <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2 pt-4">
                📞 Active / Offering Calls ({metrics?.activeCalls.length || 0})
              </h2>

              {(!metrics?.activeCalls || metrics.activeCalls.length === 0) ? (
                <div className="py-8 text-center text-sm text-gray-500 border border-dashed rounded-lg">
                  No calls currently offering or connected.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-gray-50 border-b text-gray-600 font-semibold">
                      <tr>
                        <th className="py-2.5 px-3">Caller</th>
                        <th className="py-2.5 px-3">State</th>
                        <th className="py-2.5 px-3">Assigned Agent</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {metrics.activeCalls.map((c) => (
                        <tr key={c.id}>
                          <td className="py-2.5 px-3 font-medium text-gray-900">{c.callerPhoneNumber}</td>
                          <td className="py-2.5 px-3">
                            <span className={`px-2 py-0.5 text-xs font-semibold rounded ${
                              c.status === 'connected' ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-100 text-blue-800'
                            }`}>
                              {c.status.toUpperCase()}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 text-gray-600">{c.assignedAgentId || 'Unassigned'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* AGENT PRESENCE MATRIX */}
            <div className="bg-white rounded-xl border shadow-sm p-5 space-y-4">
              <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                👥 Agent Presence ({metrics?.agentPresence.length || 0})
              </h2>

              {(!metrics?.agentPresence || metrics.agentPresence.length === 0) ? (
                <div className="py-8 text-center text-sm text-gray-500 border border-dashed rounded-lg">
                  No queue agents registered.
                </div>
              ) : (
                <div className="space-y-3">
                  {metrics.agentPresence.map((agent) => {
                    let badgeColor = 'bg-gray-100 text-gray-700';
                    if (agent.status === 'available') badgeColor = 'bg-emerald-100 text-emerald-800 border-emerald-300';
                    if (agent.status === 'ringing') badgeColor = 'bg-amber-100 text-amber-800 border-amber-300';
                    if (agent.status === 'on_call') badgeColor = 'bg-blue-100 text-blue-800 border-blue-300';
                    if (agent.status === 'offline') badgeColor = 'bg-slate-100 text-slate-600';

                    return (
                      <div key={agent.userId} className="p-3 border rounded-lg flex items-center justify-between">
                        <div>
                          <div className="font-semibold text-gray-900 text-sm">{agent.fullName || agent.email}</div>
                          <div className="text-xs text-gray-500">
                            {agent.queueNames.join(', ') || 'No Queues'}
                          </div>
                        </div>
                        <span className={`px-2.5 py-1 text-xs font-bold rounded-full border ${badgeColor}`}>
                          {agent.status.toUpperCase()}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
