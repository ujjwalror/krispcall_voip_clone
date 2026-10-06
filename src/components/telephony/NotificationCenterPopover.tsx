'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Bell, Check, CheckCheck, AlertTriangle, ShieldAlert, Info, X, CreditCard, Phone } from 'lucide-react';
import Link from 'next/link';

export interface CustomerNotificationItem {
  id: string;
  organizationId: string;
  phoneNumberId: string;
  phoneNumberE164: string;
  eventType: string;
  channel: string;
  deliveryStatus: string;
  createdAt: string;
  severity: 'high' | 'medium' | 'low';
  read: boolean;
  readAt?: string | null;
  acknowledged: boolean;
  acknowledgedAt?: string | null;
  metadata?: Record<string, any>;
}

interface NotificationCenterPopoverProps {
  initialNotifications?: CustomerNotificationItem[];
  initialUnreadCount?: number;
}

export function NotificationCenterPopover({
  initialNotifications = [],
  initialUnreadCount = 0,
}: NotificationCenterPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<CustomerNotificationItem[]>(initialNotifications);
  const [unreadCount, setUnreadCount] = useState<number>(initialUnreadCount);
  const [isLoading, setIsLoading] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Safe formatting helper for E.164 phone numbers (e.g. +18005550199 -> +1 (800) 555-0199)
  const formatE164 = (e164: string) => {
    if (!e164) return '';
    const cleaned = e164.replace(/[^\d+]/g, '');
    if (cleaned.startsWith('+1') && cleaned.length === 12) {
      return `+1 (${cleaned.slice(2, 5)}) ${cleaned.slice(5, 8)}-${cleaned.slice(8)}`;
    }
    return cleaned;
  };

  // Close popover on outside click or Escape key
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  // Fetch notifications on component mount or toggle
  const fetchNotifications = async () => {
    try {
      setIsLoading(true);
      const res = await fetch('/api/notifications/lifecycle');
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications || []);
        setUnreadCount(data.unreadCount || 0);
      }
    } catch (err) {
      console.warn('[NotificationCenterPopover] Failed to fetch notifications:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchNotifications();
  }, []);

  const handleTogglePopover = () => {
    if (!isOpen) {
      fetchNotifications();
    }
    setIsOpen((prev) => !prev);
  };

  // Idempotent Mark as Read handler
  const handleMarkAsRead = async (notificationId: string) => {
    try {
      // Optimistic state update
      setNotifications((prev) =>
        prev.map((n) => (n.id === notificationId ? { ...n, read: true, readAt: new Date().toISOString() } : n))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));

      await fetch('/api/notifications/lifecycle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notificationId, action: 'read' }),
      });
    } catch (err) {
      console.error('[NotificationCenterPopover] Failed to mark as read:', err);
    }
  };

  // Idempotent Acknowledge handler (Evidence only — does NOT authorize number release or waive rights)
  const handleAcknowledge = async (notificationId: string) => {
    try {
      setNotifications((prev) =>
        prev.map((n) =>
          n.id === notificationId
            ? { ...n, read: true, acknowledged: true, acknowledgedAt: new Date().toISOString() }
            : n
        )
      );

      await fetch('/api/notifications/lifecycle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notificationId, action: 'acknowledge' }),
      });
    } catch (err) {
      console.error('[NotificationCenterPopover] Failed to acknowledge notification:', err);
    }
  };

  // Helper to map event types to customer-understandable copy
  const getEventCopy = (item: CustomerNotificationItem) => {
    const formattedPhone = formatE164(item.phoneNumberE164);
    switch (item.eventType) {
      case 'cancellation_notice':
        return {
          title: 'Subscription Cancellation Scheduled',
          description: `Service for ${formattedPhone} remains active until the end of the current billing cycle.`,
          actionLabel: 'View Billing',
          actionUrl: '/billing',
        };
      case 'past_due_warning':
        return {
          title: 'Payment Past Due',
          description: `Action is required to maintain ${formattedPhone} and avoid service suspension.`,
          actionLabel: 'Update Payment Method',
          actionUrl: '/billing',
        };
      case 'suspension_warning':
      case 'service_suspended':
        return {
          title: 'Service Suspended',
          description: `Calling & messaging disabled for ${formattedPhone}. Update payment to restore service.`,
          actionLabel: 'Restore Service',
          actionUrl: '/billing',
        };
      case 'release_pending_warning':
        return {
          title: 'URGENT: Number at Risk',
          description: `${formattedPhone} is entering carrier release eligibility. Payment required to retain number.`,
          actionLabel: 'Pay & Retain Number',
          actionUrl: '/billing',
        };
      case 'number_released':
        return {
          title: 'Number Surrendered',
          description: `${formattedPhone} is no longer active on your account. Historical records remain saved.`,
          actionLabel: 'View Numbers',
          actionUrl: `/numbers/${item.phoneNumberId || ''}`,
        };
      default:
        return {
          title: 'Notification',
          description: `Update regarding phone number ${formattedPhone}.`,
          actionLabel: 'View Details',
          actionUrl: '/billing',
        };
    }
  };

  return (
    <div className="relative inline-block" ref={popoverRef}>
      {/* Trigger Bell Button */}
      <button
        onClick={handleTogglePopover}
        aria-label={`Notification center, ${unreadCount} unread notifications`}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className="relative p-2 rounded-xl text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <>
            <span className="absolute top-1.5 right-1.5 w-2.5 h-2.5 rounded-full bg-red-500 animate-ping" />
            <span className="absolute top-1.5 right-1.5 w-2.5 h-2.5 rounded-full bg-red-500 flex items-center justify-center text-[9px] font-bold text-white">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          </>
        )}
      </button>

      {/* Popover Dropdown Panel */}
      {isOpen && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 mt-2 w-80 sm:w-96 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-150"
        >
          {/* Popover Header */}
          <div className="p-4 border-b border-slate-100 dark:border-slate-800/80 flex items-center justify-between bg-slate-50/50 dark:bg-slate-900/40">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">Notifications</h3>
              {unreadCount > 0 && (
                <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300">
                  {unreadCount} new
                </span>
              )}
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg transition-colors"
              aria-label="Close notification panel"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Notification List */}
          <div className="max-h-[420px] overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/60">
            {isLoading && notifications.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-400">Loading notifications...</div>
            ) : notifications.length === 0 ? (
              <div className="p-8 text-center flex flex-col items-center gap-2 text-slate-400 dark:text-slate-500">
                <Bell className="w-8 h-8 stroke-1 text-slate-300 dark:text-slate-700" />
                <p className="text-xs font-medium">No recent notifications</p>
                <p className="text-[11px]">Your numbers and service status are up to date.</p>
              </div>
            ) : (
              notifications.map((item) => {
                const copy = getEventCopy(item);
                const formattedTime = new Date(item.createdAt).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                });

                return (
                  <div
                    key={item.id}
                    className={`p-4 transition-colors ${
                      !item.read
                        ? 'bg-blue-50/40 dark:bg-blue-950/20'
                        : 'hover:bg-slate-50/60 dark:hover:bg-slate-900/40'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      {/* Severity Icon & Visual Pill */}
                      <div className="shrink-0 mt-0.5">
                        {item.severity === 'high' ? (
                          <div className="p-1.5 rounded-lg bg-rose-100 dark:bg-rose-950 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-800" title="High Severity">
                            <ShieldAlert className="w-4 h-4" />
                          </div>
                        ) : item.severity === 'medium' ? (
                          <div className="p-1.5 rounded-lg bg-amber-100 dark:bg-amber-950 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-800" title="Medium Severity">
                            <AlertTriangle className="w-4 h-4" />
                          </div>
                        ) : (
                          <div className="p-1.5 rounded-lg bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800" title="Informational">
                            <Info className="w-4 h-4" />
                          </div>
                        )}
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={`text-xs font-bold ${
                              item.severity === 'high'
                                ? 'text-rose-700 dark:text-rose-300'
                                : item.severity === 'medium'
                                ? 'text-amber-700 dark:text-amber-300'
                                : 'text-slate-900 dark:text-slate-100'
                            }`}
                          >
                            {copy.title}
                          </span>
                          <span className="text-[10px] text-slate-400 shrink-0 font-mono">{formattedTime}</span>
                        </div>

                        {/* Textual Severity Label for Accessibility */}
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <span
                            className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.2 rounded ${
                              item.severity === 'high'
                                ? 'bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300'
                                : item.severity === 'medium'
                                ? 'bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
                            }`}
                          >
                            {item.severity} severity
                          </span>
                        </div>

                        <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 leading-relaxed">
                          {copy.description}
                        </p>

                        {/* CTA and Read / Acknowledge Buttons */}
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                          <Link
                            href={copy.actionUrl}
                            onClick={() => setIsOpen(false)}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
                          >
                            {copy.actionLabel} &rarr;
                          </Link>

                          <div className="flex items-center gap-1.5">
                            {!item.read && (
                              <button
                                onClick={() => handleMarkAsRead(item.id)}
                                className="px-2 py-1 rounded text-[11px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors flex items-center gap-1"
                                title="Mark notice as read"
                              >
                                <Check className="w-3 h-3" />
                                Read
                              </button>
                            )}

                            {!item.acknowledged ? (
                              <button
                                onClick={() => handleAcknowledge(item.id)}
                                className="px-2 py-1 rounded text-[11px] font-medium bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900 transition-colors flex items-center gap-1"
                                title="Acknowledge receipt (evidence log only)"
                              >
                                <CheckCheck className="w-3 h-3" />
                                Acknowledge
                              </button>
                            ) : (
                              <span className="text-[10px] text-slate-400 flex items-center gap-1">
                                <CheckCheck className="w-3 h-3 text-emerald-500" />
                                Acknowledged
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Footer */}
          <div className="p-3 bg-slate-50 dark:bg-slate-900/60 border-t border-slate-100 dark:border-slate-800 text-center">
            <Link
              href="/billing"
              onClick={() => setIsOpen(false)}
              className="text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
            >
              View Number & Subscription Settings
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
