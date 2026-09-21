'use client';

import React, { useState, useEffect, useRef, useMemo, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Avatar } from '@/components/ui/Avatar';
import {
  MessageSquare,
  Send,
  Search,
  PhoneCall,
  Check,
  CheckCheck,
  AlertCircle,
  Clock,
  Plus,
  ArrowLeft,
  X,
  Phone,
  ShieldAlert,
  Info,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { formatDisplayPhoneNumber, parseAndNormalizePhoneNumber } from '@/lib/utils';
import parsePhoneNumberFromString, { getCountries, getCountryCallingCode, CountryCode } from 'libphonenumber-js';

interface ConversationSummary {
  id: string; // `${businessPhoneNumber}:${customerPhoneNumber}`
  customerPhoneNumber: string;
  businessPhoneNumber: string;
  contactName: string | null;
  contactId: string | null;
  displayTitle: string;
  lastMessage: string;
  lastMessageAt: string;
  lastMessageDirection: 'inbound' | 'outbound';
  lastMessageStatus: string;
  unreadCount: number;
}

interface MessageItem {
  id: string;
  organization_id: string;
  twilio_message_sid: string | null;
  user_id: string | null;
  contact_id: string | null;
  from_number: string;
  to_number: string;
  body: string;
  direction: 'inbound' | 'outbound';
  status: string;
  error_code: string | null;
  error_message: string | null;
  is_read: boolean;
  created_at: string;
  senderName?: string | null;
}

interface SmsPhoneNumber {
  id: string;
  phone_number: string;
  friendly_name: string | null;
  is_primary: boolean;
  capabilities_sms: boolean;
}

interface ContactOption {
  id: string;
  full_name: string;
  phone: string;
}

function MessagesContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<ConversationSummary | null>(null);
  const [messagesHistory, setMessagesHistory] = useState<MessageItem[]>([]);
  const [smsPhoneNumbers, setSmsPhoneNumbers] = useState<SmsPhoneNumber[]>([]);
  const [selectedBusinessNumber, setSelectedBusinessNumber] = useState<string>('');

  const [isLoadingConversations, setIsLoadingConversations] = useState(true);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const [composeBody, setComposeBody] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [persistenceWarning, setPersistenceWarning] = useState<string | null>(null);

  // New Message Modal State
  const [showNewModal, setShowNewModal] = useState(false);
  const [modalRecipientType, setModalRecipientType] = useState<'contact' | 'manual'>('manual');
  const [modalContacts, setModalContacts] = useState<ContactOption[]>([]);
  const [modalSelectedContactId, setModalSelectedContactId] = useState('');
  const [modalRawPhone, setModalRawPhone] = useState('');
  const [modalSelectedCountry, setModalSelectedCountry] = useState('');
  const [modalBusinessNumber, setModalBusinessNumber] = useState('');
  const [modalInitialBody, setModalInitialBody] = useState('');
  const [modalError, setModalError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const supabase = useMemo(() => createClient(), []);

  // Format options for country select dropdown in New Message modal
  const countryOptions = useMemo(() => {
    const displayNames =
      typeof Intl !== 'undefined' && (Intl as any).DisplayNames
        ? new (Intl as any).DisplayNames(['en'], { type: 'region' })
        : null;

    const codes = getCountries();
    const list: { code: CountryCode; name: string; prefix: string }[] = [];

    for (const c of codes) {
      try {
        const prefix = getCountryCallingCode(c);
        const name = displayNames ? displayNames.of(c) || c : c;
        list.push({ code: c, name, prefix: `+${prefix}` });
      } catch {}
    }

    list.sort((a, b) => a.name.localeCompare(b.name));
    const priorityCodes: CountryCode[] = ['IN', 'AU', 'US', 'GB', 'NZ', 'CA'];
    const priority = list.filter((item) => priorityCodes.includes(item.code));
    const others = list.filter((item) => !priorityCodes.includes(item.code));
    return { priority, others };
  }, []);

  // Scroll message stream to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messagesHistory]);

  // Load conversations and SMS-capable business lines on mount
  useEffect(() => {
    loadConversations();
    loadSmsPhoneNumbers();
    loadContactsForModal();
  }, []);

  // Handle URL prefill (e.g. /messages?to=+61412345678)
  useEffect(() => {
    const toParam = searchParams.get('to');
    if (toParam && !isLoadingConversations) {
      const targetPhone = toParam.trim();
      const existing = conversations.find((c) => c.customerPhoneNumber === targetPhone);
      if (existing) {
        setSelectedConversation(existing);
      } else {
        setModalRawPhone(targetPhone);
        setShowNewModal(true);
      }
    }
  }, [searchParams, isLoadingConversations, conversations]);

  // Load message history & mark read when selected conversation changes
  useEffect(() => {
    if (selectedConversation) {
      loadMessageHistory(selectedConversation);
      markConversationRead(selectedConversation);
    }
  }, [selectedConversation?.id]);

  // Setup Supabase Realtime listener for incoming messages & status updates
  useEffect(() => {
    const channel = supabase
      .channel('realtime-messages-ui')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'messages',
        },
        (payload) => {
          const newRow = payload.new as any;
          if (!newRow) return;

          // If event matches currently open conversation, update stream
          if (selectedConversation) {
            const isMatch =
              (newRow.from_number === selectedConversation.businessPhoneNumber &&
                newRow.to_number === selectedConversation.customerPhoneNumber) ||
              (newRow.from_number === selectedConversation.customerPhoneNumber &&
                newRow.to_number === selectedConversation.businessPhoneNumber);

            if (isMatch) {
              if (payload.eventType === 'INSERT') {
                setMessagesHistory((prev) => {
                  if (prev.some((m) => m.id === newRow.id || (newRow.twilio_message_sid && m.twilio_message_sid === newRow.twilio_message_sid))) {
                    return prev;
                  }
                  return [...prev, newRow];
                });
                if (newRow.direction === 'inbound') {
                  markConversationRead(selectedConversation);
                }
              } else if (payload.eventType === 'UPDATE') {
                setMessagesHistory((prev) =>
                  prev.map((m) => (m.id === newRow.id ? { ...m, ...newRow } : m))
                );
              }
            }
          }

          // Refresh conversation list to update thread snippet, order & unread badges
          loadConversations();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [selectedConversation, supabase]);

  const loadConversations = async () => {
    try {
      const res = await fetch('/api/messages/conversations');
      if (res.ok) {
        const data = await res.json();
        if (data.conversations) {
          setConversations(data.conversations);
        }
      }
    } catch (err) {
      console.error('Failed to load conversations:', err);
    } finally {
      setIsLoadingConversations(false);
    }
  };

  const loadSmsPhoneNumbers = async () => {
    try {
      const res = await fetch('/api/phone-numbers/sms-capable');
      if (res.ok) {
        const data = await res.json();
        if (data.phoneNumbers && Array.isArray(data.phoneNumbers)) {
          setSmsPhoneNumbers(data.phoneNumbers);
          if (data.phoneNumbers.length > 0) {
            setSelectedBusinessNumber(data.phoneNumbers[0].phone_number);
            setModalBusinessNumber(data.phoneNumbers[0].phone_number);
          }
        }
      }
    } catch (err) {
      console.error('Failed to load SMS business lines:', err);
    }
  };

  const loadContactsForModal = async () => {
    try {
      const res = await fetch('/api/contacts?limit=100');
      if (res.ok) {
        const data = await res.json();
        if (data.contacts && Array.isArray(data.contacts)) {
          setModalContacts(data.contacts);
        }
      }
    } catch (err) {
      console.error('Failed to load contacts for modal:', err);
    }
  };

  const loadMessageHistory = async (conv: ConversationSummary) => {
    setIsLoadingHistory(true);
    setSendError(null);
    setPersistenceWarning(null);
    try {
      const url = `/api/messages/history?customerNumber=${encodeURIComponent(
        conv.customerPhoneNumber
      )}&businessNumber=${encodeURIComponent(conv.businessPhoneNumber)}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data.messages) {
          setMessagesHistory(data.messages);
        }
      }
    } catch (err) {
      console.error('Failed to load message history:', err);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const markConversationRead = async (conv: ConversationSummary) => {
    if (conv.unreadCount <= 0) return;
    try {
      await fetch('/api/messages/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerNumber: conv.customerPhoneNumber,
          businessNumber: conv.businessPhoneNumber,
        }),
      });
      // Optimistically clear unread count in state
      setConversations((prev) =>
        prev.map((c) => (c.id === conv.id ? { ...c, unreadCount: 0 } : c))
      );
    } catch (err) {
      console.warn('Failed to mark conversation read:', err);
    }
  };

  // Handle Outbound Send from active conversation
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedConversation) return;

    const bodyToSend = composeBody.trim();
    if (!bodyToSend || isSending) return;

    const fromNum = selectedBusinessNumber || selectedConversation.businessPhoneNumber;
    if (!fromNum) {
      setSendError('Please select an active SMS-capable business number.');
      return;
    }

    setIsSending(true);
    setSendError(null);
    setPersistenceWarning(null);

    try {
      const res = await fetch('/api/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromNumber: fromNum,
          toNumber: selectedConversation.customerPhoneNumber,
          body: bodyToSend,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success && data.message) {
        setComposeBody('');
        setMessagesHistory((prev) => [...prev, data.message]);
        loadConversations();
        return;
      }

      // Check for provider transmission success with persistence failure (HTTP 500)
      if (res.status === 500 && data.error && data.error.includes('transmitted')) {
        setPersistenceWarning(
          '⚠️ Message may already have been sent via provider, but VoIP Hub could not save the message record. Please check before sending again.'
        );
      } else {
        setSendError(data.error || 'Failed to send SMS message. Please retry.');
      }
    } catch (err: any) {
      console.error('Send error:', err);
      setSendError('Network error encountered while sending message.');
    } finally {
      setIsSending(false);
    }
  };

  // Handle New Message Modal Submission
  const handleCreateNewMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalError(null);

    let targetPhoneNumber = '';

    if (modalRecipientType === 'contact') {
      const contact = modalContacts.find((c) => c.id === modalSelectedContactId);
      if (!contact) {
        setModalError('Please select a valid contact.');
        return;
      }
      targetPhoneNumber = contact.phone;
    } else {
      const normResult = parseAndNormalizePhoneNumber(
        modalRawPhone,
        modalSelectedCountry || undefined
      );
      if (!normResult.isValid || !normResult.normalized) {
        setModalError(normResult.error || 'Please enter a valid phone number.');
        return;
      }
      targetPhoneNumber = normResult.normalized;
    }

    const bodyToSend = modalInitialBody.trim();
    if (!bodyToSend) {
      setModalError('Please enter a message body.');
      return;
    }

    if (!modalBusinessNumber) {
      setModalError('No active SMS-capable business number selected.');
      return;
    }

    setIsSending(true);

    try {
      const res = await fetch('/api/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromNumber: modalBusinessNumber,
          toNumber: targetPhoneNumber,
          body: bodyToSend,
          defaultCountry: modalSelectedCountry || undefined,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success && data.message) {
        setShowNewModal(false);
        setModalInitialBody('');
        setModalRawPhone('');
        setModalError(null);

        // Reload conversations and select the newly created thread
        await loadConversations();
        const convKey = `${modalBusinessNumber}:${targetPhoneNumber}`;
        setSelectedConversation({
          id: convKey,
          customerPhoneNumber: targetPhoneNumber,
          businessPhoneNumber: modalBusinessNumber,
          contactName:
            modalRecipientType === 'contact'
              ? modalContacts.find((c) => c.id === modalSelectedContactId)?.full_name || null
              : null,
          contactId: modalRecipientType === 'contact' ? modalSelectedContactId : null,
          displayTitle: formatDisplayPhoneNumber(targetPhoneNumber),
          lastMessage: bodyToSend,
          lastMessageAt: new Date().toISOString(),
          lastMessageDirection: 'outbound',
          lastMessageStatus: data.status || 'sent',
          unreadCount: 0,
        });
        return;
      }

      setModalError(data.error || 'Failed to initiate new message.');
    } catch (err) {
      setModalError('Network error initiating message.');
    } finally {
      setIsSending(false);
    }
  };

  // Filter conversations by search query
  const filteredConversations = useMemo(() => {
    if (!searchQuery.trim()) return conversations;
    const query = searchQuery.toLowerCase().trim();
    return conversations.filter(
      (c) =>
        (c.contactName && c.contactName.toLowerCase().includes(query)) ||
        c.customerPhoneNumber.includes(query) ||
        c.lastMessage.toLowerCase().includes(query)
    );
  }, [conversations, searchQuery]);

  // Parse modal raw phone live normalization preview
  const modalPhonePreview = useMemo(() => {
    if (!modalRawPhone.trim()) return null;
    const res = parseAndNormalizePhoneNumber(modalRawPhone, modalSelectedCountry || undefined);
    return res;
  }, [modalRawPhone, modalSelectedCountry]);

  // Format relative timestamp
  const formatRelativeTime = (isoString: string) => {
    if (!isoString) return '';
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '';

    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  return (
    <div className="h-[calc(100vh-7rem)] flex flex-col md:flex-row gap-4">
      {/* ------------------------------------------------------------------ */}
      {/* Left Sidebar: Conversation List */}
      {/* ------------------------------------------------------------------ */}
      <div
        className={`w-full md:w-80 flex flex-col gap-3 bg-white dark:bg-slate-900/60 rounded-2xl border border-slate-200 dark:border-slate-800/80 p-4 ${
          selectedConversation ? 'hidden md:flex' : 'flex'
        }`}
      >
        <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800">
          <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <span>Messages</span>
          </h2>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setShowNewModal(true)}
              title="New SMS Message"
            >
              <Plus className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
              <span>New</span>
            </Button>
            <Badge variant="blue" size="sm">
              SMS
            </Badge>
          </div>
        </div>

        <Input
          icon={<Search className="w-4 h-4 text-slate-400" />}
          placeholder="Search messages or contacts..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />

        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {isLoadingConversations ? (
            <div className="p-8 text-center text-xs text-slate-400">
              <Clock className="w-5 h-5 mx-auto mb-2 animate-spin text-blue-500" />
              Loading messages...
            </div>
          ) : filteredConversations.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
              <MessageSquare className="w-8 h-8 mx-auto mb-2 text-slate-300 dark:text-slate-700" />
              {searchQuery ? 'No matching conversations found.' : 'No conversations yet.'}
              {!searchQuery && (
                <p className="mt-2 text-[11px] text-slate-400">
                  Click <span className="font-semibold text-blue-500">New</span> above to start an SMS conversation.
                </p>
              )}
            </div>
          ) : (
            filteredConversations.map((conv) => {
              const isSelected = selectedConversation?.id === conv.id;
              return (
                <div
                  key={conv.id}
                  onClick={() => setSelectedConversation(conv)}
                  className={`p-3 rounded-xl border cursor-pointer transition-all ${
                    isSelected
                      ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-300 dark:border-blue-800/80 shadow-sm'
                      : 'bg-slate-50/70 hover:bg-slate-100 dark:bg-slate-950/60 dark:hover:bg-slate-800/60 border-slate-200 dark:border-slate-800/80'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate max-w-[170px]">
                      {conv.contactName || formatDisplayPhoneNumber(conv.customerPhoneNumber)}
                    </span>
                    <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono">
                      {formatRelativeTime(conv.lastMessageAt)}
                    </span>
                  </div>

                  <div className="flex items-center justify-between mt-1 gap-2">
                    <p className="text-xs text-slate-500 dark:text-slate-400 truncate flex-1">
                      {conv.lastMessageDirection === 'outbound' && <span className="text-blue-500 font-medium">You: </span>}
                      {conv.lastMessage}
                    </p>
                    {conv.unreadCount > 0 && (
                      <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-blue-600 text-white min-w-[18px] text-center">
                        {conv.unreadCount}
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Right Main Stream: Conversation History & Composer */}
      {/* ------------------------------------------------------------------ */}
      <div
        className={`flex-1 flex flex-col bg-white dark:bg-slate-900/60 rounded-2xl border border-slate-200 dark:border-slate-800/80 overflow-hidden ${
          !selectedConversation ? 'hidden md:flex' : 'flex'
        }`}
      >
        {selectedConversation ? (
          <>
            {/* Header */}
            <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-950/40">
              <div className="flex items-center gap-3">
                <Button
                  variant="ghost"
                  size="sm"
                  className="md:hidden h-8 w-8 p-0"
                  onClick={() => setSelectedConversation(null)}
                >
                  <ArrowLeft className="w-4 h-4" />
                </Button>
                <Avatar
                  name={selectedConversation.contactName || selectedConversation.customerPhoneNumber}
                  size="md"
                />
                <div>
                  <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100">
                    {selectedConversation.contactName || formatDisplayPhoneNumber(selectedConversation.customerPhoneNumber)}
                  </h3>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                    {formatDisplayPhoneNumber(selectedConversation.customerPhoneNumber)}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Badge variant="neutral" size="sm" className="font-mono text-[10px]">
                  Line: {formatDisplayPhoneNumber(selectedConversation.businessPhoneNumber)}
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => router.push(`/phone?dial=${encodeURIComponent(selectedConversation.customerPhoneNumber)}`)}
                >
                  <PhoneCall className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span>Call</span>
                </Button>
              </div>
            </div>

            {/* Persistence Warning Alert Banner */}
            {persistenceWarning && (
              <div className="p-3 bg-amber-500/10 border-b border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 flex-shrink-0" />
                <span>{persistenceWarning}</span>
              </div>
            )}

            {/* Send Error Banner */}
            {sendError && (
              <div className="p-3 bg-red-500/10 border-b border-red-500/20 text-red-600 dark:text-red-400 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{sendError}</span>
              </div>
            )}

            {/* Message History Stream */}
            <div className="flex-1 p-4 overflow-y-auto space-y-3 bg-slate-50/30 dark:bg-slate-950/20">
              {isLoadingHistory ? (
                <div className="p-8 text-center text-xs text-slate-400">
                  <Clock className="w-5 h-5 mx-auto mb-2 animate-spin text-blue-500" />
                  Loading message history...
                </div>
              ) : messagesHistory.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-400">
                  No messages in this conversation yet. Send a message below to start chatting.
                </div>
              ) : (
                messagesHistory.map((msg) => {
                  const isOutbound = msg.direction === 'outbound';
                  return (
                    <div
                      key={msg.id}
                      className={`flex flex-col max-w-sm ${isOutbound ? 'items-end ml-auto' : 'items-start'}`}
                    >
                      <div
                        className={`p-3 rounded-2xl text-xs shadow-sm ${
                          isOutbound
                            ? 'rounded-tr-xs bg-blue-600 text-white shadow-blue-600/10'
                            : 'rounded-tl-xs bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 border border-slate-200 dark:border-slate-700/60'
                        }`}
                      >
                        {msg.body}
                      </div>

                      <div
                        className={`flex items-center gap-1 mt-1 font-mono text-[9px] ${
                          isOutbound ? 'mr-1 text-slate-500 dark:text-slate-400' : 'ml-1 text-slate-400'
                        }`}
                      >
                        {msg.senderName && <span className="font-sans text-[10px] text-slate-400 font-medium">{msg.senderName} • </span>}
                        <span>
                          {new Date(msg.created_at).toLocaleTimeString([], {
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </span>

                        {isOutbound && (
                          <span className="ml-1 inline-flex items-center">
                            {msg.status === 'queued' || msg.status === 'sending' ? (
                              <span title="Sending...">
                                <Clock className="w-3 h-3 text-slate-400 animate-pulse" />
                              </span>
                            ) : msg.status === 'sent' ? (
                              <span title="Sent">
                                <Check className="w-3 h-3 text-slate-400" />
                              </span>
                            ) : msg.status === 'delivered' ? (
                              <span title="Delivered">
                                <CheckCheck className="w-3.5 h-3.5 text-blue-400" />
                              </span>
                            ) : msg.status === 'failed' || msg.status === 'undelivered' ? (
                              <span className="flex items-center gap-0.5 text-red-500 font-semibold" title={msg.error_message || 'Delivery failed'}>
                                <AlertCircle className="w-3 h-3" />
                                <span>Failed</span>
                              </span>
                            ) : (
                              <span title={msg.status}>
                                <Check className="w-3 h-3 text-slate-400" />
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Composer Footer */}
            <form onSubmit={handleSendMessage} className="p-3 border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/80 flex flex-col gap-2">
              {smsPhoneNumbers.length === 0 ? (
                <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs flex items-center gap-2">
                  <Info className="w-4 h-4 flex-shrink-0" />
                  <span>No SMS-capable business line is connected yet. Select or configure an SMS line to enable sending.</span>
                </div>
              ) : (
                <>
                  {smsPhoneNumbers.length > 1 && (
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <span>Send from line:</span>
                      <select
                        value={selectedBusinessNumber}
                        onChange={(e) => setSelectedBusinessNumber(e.target.value)}
                        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-2 py-1 text-xs"
                      >
                        {smsPhoneNumbers.map((num) => (
                          <option key={num.id} value={num.phone_number}>
                            {num.friendly_name || 'Business'} ({formatDisplayPhoneNumber(num.phone_number)})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <div className="flex-1 relative">
                      <textarea
                        rows={1}
                        placeholder="Type SMS message..."
                        value={composeBody}
                        onChange={(e) => setComposeBody(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleSendMessage(e);
                          }
                        }}
                        className="w-full resize-none rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 pr-12"
                      />
                      <span className="absolute right-3 bottom-2 text-[10px] text-slate-400 font-mono">
                        {composeBody.length}/1600
                      </span>
                    </div>

                    <Button
                      type="submit"
                      variant="primary"
                      size="md"
                      disabled={!composeBody.trim() || isSending || smsPhoneNumbers.length === 0}
                    >
                      <Send className="w-4 h-4" />
                    </Button>
                  </div>
                </>
              )}
            </form>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div className="w-12 h-12 rounded-2xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900/60 flex items-center justify-center text-blue-600 dark:text-blue-400 mb-3">
              <MessageSquare className="w-6 h-6" />
            </div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">Select a Conversation</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mt-1">
              Choose an existing conversation thread from the left or click New to start a new SMS.
            </p>
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* New Message Modal */}
      {/* ------------------------------------------------------------------ */}
      {showNewModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden flex flex-col">
            <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-950/40">
              <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                <Plus className="w-4 h-4 text-blue-500" />
                <span>New SMS Message</span>
              </h3>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => {
                  setShowNewModal(false);
                  setModalError(null);
                }}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>

            <form onSubmit={handleCreateNewMessage} className="p-4 space-y-4">
              {modalError && (
                <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-xs flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{modalError}</span>
                </div>
              )}

              {/* Recipient Type Switcher */}
              <div className="flex rounded-xl bg-slate-100 dark:bg-slate-800 p-1 text-xs">
                <button
                  type="button"
                  onClick={() => setModalRecipientType('contact')}
                  className={`flex-1 py-1.5 rounded-lg font-semibold transition-all ${
                    modalRecipientType === 'contact'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-500 dark:text-slate-400'
                  }`}
                >
                  Saved Contact
                </button>
                <button
                  type="button"
                  onClick={() => setModalRecipientType('manual')}
                  className={`flex-1 py-1.5 rounded-lg font-semibold transition-all ${
                    modalRecipientType === 'manual'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-500 dark:text-slate-400'
                  }`}
                >
                  Unsaved Number
                </button>
              </div>

              {/* Recipient Selector */}
              {modalRecipientType === 'contact' ? (
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Select Contact</label>
                  <select
                    value={modalSelectedContactId}
                    onChange={(e) => setModalSelectedContactId(e.target.value)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Select a contact...</option>
                    {modalContacts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.full_name} ({formatDisplayPhoneNumber(c.phone)})
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Recipient Phone Number</label>
                  <div className="flex gap-2">
                    <select
                      value={modalSelectedCountry}
                      onChange={(e) => setModalSelectedCountry(e.target.value)}
                      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-2.5 py-2 text-xs text-slate-900 dark:text-slate-100 w-36 flex-shrink-0"
                    >
                      <option value="">Select country</option>
                      {countryOptions.priority.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.name} ({c.prefix})
                        </option>
                      ))}
                      <option disabled>──────────</option>
                      {countryOptions.others.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.name} ({c.prefix})
                        </option>
                      ))}
                    </select>
                    <Input
                      placeholder="e.g. 0412345678 or +61412345678"
                      value={modalRawPhone}
                      onChange={(e) => setModalRawPhone(e.target.value)}
                      className="flex-1"
                    />
                  </div>

                  {modalPhonePreview && modalPhonePreview.isValid && (
                    <div className="text-[11px] text-emerald-500 mt-1 font-mono">
                      Formatted E.164: {modalPhonePreview.normalized}
                    </div>
                  )}
                  {modalPhonePreview && !modalPhonePreview.isValid && modalRawPhone.trim() && (
                    <div className="text-[11px] font-mono text-amber-500 mt-1">
                      {modalPhonePreview.error || 'Enter a valid phone number.'}
                    </div>
                  )}
                </div>
              )}

              {/* Business Line Selector */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Sending Business Line</label>
                {smsPhoneNumbers.length === 0 ? (
                  <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs">
                    No SMS-capable business number is connected yet.
                  </div>
                ) : (
                  <select
                    value={modalBusinessNumber}
                    onChange={(e) => setModalBusinessNumber(e.target.value)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {smsPhoneNumbers.map((num) => (
                      <option key={num.id} value={num.phone_number}>
                        {num.friendly_name || 'Business'} ({formatDisplayPhoneNumber(num.phone_number)})
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Initial Message Body */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Message</label>
                <textarea
                  rows={3}
                  placeholder="Type initial message..."
                  value={modalInitialBody}
                  onChange={(e) => setModalInitialBody(e.target.value)}
                  className="w-full resize-none rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowNewModal(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={isSending || smsPhoneNumbers.length === 0}
                >
                  {isSending ? 'Sending...' : 'Send Message'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default function MessagesPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-xs text-slate-400">Loading Messages...</div>}>
      <MessagesContent />
    </Suspense>
  );
}
