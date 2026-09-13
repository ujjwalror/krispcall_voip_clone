'use client';

import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Avatar } from '@/components/ui/Avatar';
import {
  X,
  PhoneCall,
  MessageSquare,
  Mail,
  Building,
  Calendar,
  Clock,
  Ban,
  CheckCircle2,
  Edit,
  Trash2,
  History,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import { Contact } from '@/lib/types';
import { formatCallTime, formatDuration } from '@/lib/utils';
import { useAuth } from '@/components/providers/AuthProvider';
import { BlockContactConfirmationModal } from '@/components/contacts/BlockContactConfirmationModal';

interface ContactDetailsModalProps {
  contactId: string | null;
  isOpen: boolean;
  onClose: () => void;
  onEdit: (contact: Contact) => void;
  onDelete: (contact: Contact) => void;
  onCall: (phoneNumber: string, isBlocked: boolean, contactName?: string) => void;
  onMessage: (phoneNumber: string) => void;
  onStatusChange: () => void;
}

export function ContactDetailsModal({
  contactId,
  isOpen,
  onClose,
  onEdit,
  onDelete,
  onCall,
  onMessage,
  onStatusChange,
}: ContactDetailsModalProps) {
  const [contact, setContact] = useState<Contact | null>(null);
  const { profile } = useAuth();
  const [callsHistory, setCallsHistory] = useState<any[]>([]);
  const [messagesHistory, setMessagesHistory] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'details' | 'calls' | 'messages'>('details');
  const [isLoading, setIsLoading] = useState(false);
  const [isBlocking, setIsBlocking] = useState(false);
  const [isConfirmingBlock, setIsConfirmingBlock] = useState(false);
  const [blockedAlert, setBlockedAlert] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && contactId) {
      fetchContactDetails(contactId);
    }
  }, [isOpen, contactId]);

  const fetchContactDetails = async (id: string) => {
    setIsLoading(true);
    setBlockedAlert(null);
    try {
      const res = await fetch(`/api/contacts/${id}`);
      if (res.ok) {
        const data = await res.json();
        setContact(data.contact || null);
        setCallsHistory(data.history?.calls || []);
        setMessagesHistory(data.history?.messages || []);
      }
    } catch (err) {
      console.error('Error loading contact details:', err);
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen || !contactId) return null;

  const handleUnblock = async () => {
    if (!contact) return;
    setIsBlocking(true);
    try {
      const res = await fetch(`/api/contacts/${contact.id}/block`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isBlocked: false }),
      });
      if (res.ok) {
        const data = await res.json();
        setContact(data.contact || { ...contact, is_blocked: false });
        onStatusChange();
      }
    } catch (err) {
      console.error('Error unblocking contact:', err);
    } finally {
      setIsBlocking(false);
    }
  };

  const handleCallClick = () => {
    if (!contact) return;
    if (contact.is_blocked) {
      setBlockedAlert('This contact is blocked. Unblock the contact before calling.');
      return;
    }
    onCall(contact.phone, false, contact.full_name);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in">
      <div className="w-full max-w-xl rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-start justify-between">
          <div className="flex items-center gap-3">
            <Avatar name={contact?.full_name || 'Contact'} size="lg" />
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-slate-100">{contact?.full_name || 'Loading...'}</h2>
                {contact?.is_blocked && (
                  <Badge variant="rose" size="sm">
                    <Ban className="w-3 h-3" />
                    BLOCKED
                  </Badge>
                )}
              </div>
              <p className="text-xs text-slate-400 font-mono mt-0.5">{contact?.phone}</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center gap-1 px-5 pt-3 border-b border-slate-800/80 bg-slate-950/40 text-xs">
          <button
            onClick={() => setActiveTab('details')}
            className={`px-3 py-2 border-b-2 font-medium transition-colors ${
              activeTab === 'details'
                ? 'border-blue-500 text-blue-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Contact Overview
          </button>
          <button
            onClick={() => setActiveTab('calls')}
            className={`px-3 py-2 border-b-2 font-medium transition-colors flex items-center gap-1.5 ${
              activeTab === 'calls'
                ? 'border-blue-500 text-blue-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <span>Recent Calls</span>
            <span className="px-1.5 py-0.2 rounded-full bg-slate-800 text-[10px] text-slate-300 font-mono">
              {callsHistory.length}
            </span>
          </button>
          <button
            onClick={() => setActiveTab('messages')}
            className={`px-3 py-2 border-b-2 font-medium transition-colors flex items-center gap-1.5 ${
              activeTab === 'messages'
                ? 'border-blue-500 text-blue-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <span>Messages</span>
            <span className="px-1.5 py-0.2 rounded-full bg-slate-800 text-[10px] text-slate-300 font-mono">
              {messagesHistory.length}
            </span>
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {isLoading ? (
            <div className="p-8 text-center text-xs text-slate-400 flex flex-col items-center justify-center gap-2">
              <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
              <span>Loading contact records...</span>
            </div>
          ) : contact ? (
            <>
              {blockedAlert && (
                <div className="p-3 rounded-xl bg-rose-950/70 border border-rose-800 text-rose-200 text-xs flex items-center gap-2 animate-pulse">
                  <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                  <span>{blockedAlert}</span>
                </div>
              )}

              {activeTab === 'details' && (
                <div className="space-y-4">
                  {/* Detailed Information Grid */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1">
                      <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">First Name</p>
                      <p className="font-semibold text-slate-200">{contact.first_name || '—'}</p>
                    </div>

                    <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1">
                      <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Last Name</p>
                      <p className="font-semibold text-slate-200">{contact.last_name || '—'}</p>
                    </div>

                    <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1">
                      <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Company / Org</p>
                      <p className="font-semibold text-slate-200 flex items-center gap-1.5">
                        <Building className="w-3.5 h-3.5 text-slate-400" />
                        <span>{contact.company || 'Direct Client'}</span>
                      </p>
                    </div>

                    <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1">
                      <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Email Address</p>
                      <p className="font-semibold text-slate-200 flex items-center gap-1.5 truncate">
                        <Mail className="w-3.5 h-3.5 text-slate-400" />
                        <span className="truncate">{contact.email || '—'}</span>
                      </p>
                    </div>
                  </div>

                  {contact.notes && (
                    <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1 text-xs">
                      <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Notes & Remarks</p>
                      <p className="text-slate-300 leading-relaxed">{contact.notes}</p>
                    </div>
                  )}

                  {/* Metadata Audit */}
                  <div className="flex items-center justify-between text-[11px] text-slate-500 pt-2 border-t border-slate-800 font-mono">
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3 h-3 text-slate-600" />
                      Created: {formatCallTime(contact.created_at, profile?.timezone, profile?.time_format)}
                    </span>
                    {contact.updated_at && (
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3 text-slate-600" />
                        Updated: {formatCallTime(contact.updated_at, profile?.timezone, profile?.time_format)}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {activeTab === 'calls' && (
                <div className="space-y-2">
                  {callsHistory.length === 0 ? (
                    <p className="text-center text-xs text-slate-500 p-6">No call logs recorded for this contact.</p>
                  ) : (
                    callsHistory.map((call) => (
                      <div key={call.id} className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <Badge variant={call.direction === 'inbound' ? 'blue' : 'emerald'} size="sm">
                            {call.direction.toUpperCase()}
                          </Badge>
                          <span className="font-mono text-slate-300 capitalize">{call.status}</span>
                        </div>
                        <div className="text-right text-[11px] text-slate-400 font-mono">
                          <p>{formatCallTime(call.created_at, profile?.timezone, profile?.time_format)}</p>
                          <p>{formatDuration(call.duration_seconds || 0)}</p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {activeTab === 'messages' && (
                <div className="space-y-2">
                  {messagesHistory.length === 0 ? (
                    <p className="text-center text-xs text-slate-500 p-6">No SMS messages recorded for this contact.</p>
                  ) : (
                    messagesHistory.map((msg) => (
                      <div key={msg.id} className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1 text-xs">
                        <div className="flex items-center justify-between">
                          <Badge variant={msg.direction === 'inbound' ? 'purple' : 'neutral'} size="sm">
                            {msg.direction.toUpperCase()}
                          </Badge>
                          <span className="text-[10px] text-slate-500 font-mono">{formatCallTime(msg.created_at, profile?.timezone, profile?.time_format)}</span>
                        </div>
                        <p className="text-slate-300 text-xs">{msg.body}</p>
                      </div>
                    ))
                  )}
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* Modal Footer Actions */}
        {contact && (
          <div className="p-4 border-t border-slate-800 flex items-center justify-between gap-3 bg-slate-950/40">
            <div className="flex items-center gap-2">
              {contact.is_blocked ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleUnblock}
                  disabled={isBlocking}
                  className="border-emerald-700/60 text-emerald-300 hover:bg-emerald-950/60"
                  title="Unblock this contact"
                >
                  <Ban className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Unblock Contact</span>
                </Button>
              ) : (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setIsConfirmingBlock(true)}
                  disabled={isBlocking}
                  title="Block this contact"
                >
                  <Ban className="w-3.5 h-3.5" />
                  <span>Block Contact</span>
                </Button>
              )}

              <Button
                variant="ghost"
                size="sm"
                className="text-rose-400 hover:text-rose-300 hover:bg-rose-500/10"
                onClick={() => {
                  onClose();
                  onDelete(contact);
                }}
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Delete</span>
              </Button>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  onClose();
                  onEdit(contact);
                }}
              >
                <Edit className="w-3.5 h-3.5" />
                <span>Edit</span>
              </Button>

              {!contact.is_blocked && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onMessage(contact.phone)}
                >
                  <MessageSquare className="w-3.5 h-3.5 text-blue-400" />
                  <span>SMS</span>
                </Button>
              )}

              <Button
                variant={contact.is_blocked ? 'outline' : 'success'}
                size="sm"
                onClick={handleCallClick}
                className={contact.is_blocked ? 'opacity-60 border-slate-700 text-slate-400 cursor-not-allowed' : ''}
              >
                <PhoneCall className="w-3.5 h-3.5" />
                <span>Call</span>
              </Button>
            </div>
          </div>
        )}
      </div>

      <BlockContactConfirmationModal
        contact={contact}
        isOpen={isConfirmingBlock}
        onClose={() => setIsConfirmingBlock(false)}
        onSuccess={() => {
          if (contact) {
            setContact({ ...contact, is_blocked: true });
          }
          onStatusChange();
        }}
      />
    </div>
  );
}
