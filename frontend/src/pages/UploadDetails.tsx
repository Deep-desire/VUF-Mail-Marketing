import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft,
  Loader2,
  Send,
  XCircle,
  Clock,
  Ban,
  Play,
  Mail,
  X,
} from 'lucide-react';
import { createColumnHelper } from '@tanstack/react-table';
import toast from 'react-hot-toast';
import ReportTable from '../components/ReportTable';
import StatusBadge from '../components/StatusBadge';
import StatsCard from '../components/StatsCard';
import { uploadApi } from '../api/upload.api';
import { templateApi } from '../api/template.api';
import { Upload, Contact, Template } from '../types';

const columnHelper = createColumnHelper<Contact>();

const columns = [
  columnHelper.accessor('name', {
    header: 'Name',
    cell: (info) => <span className="font-medium text-white">{info.getValue()}</span>,
  }),
  columnHelper.accessor('email', {
    header: 'Email',
    cell: (info) => info.getValue(),
  }),
  columnHelper.accessor('status', {
    header: 'Validation',
    cell: (info) => <StatusBadge status={info.getValue()} />,
  }),
  columnHelper.accessor('deliveryStatus', {
    header: 'Delivery Status',
    cell: (info) => {
      const val = info.getValue();
      return val ? <StatusBadge status={val} /> : <span className="text-gray-600">—</span>;
    },
  }),
  columnHelper.accessor('sentAt', {
    header: 'Sent At',
    cell: (info) => {
      const val = info.getValue();
      return val ? new Date(val).toLocaleString() : '—';
    },
  }),
  columnHelper.accessor('deliveryError', {
    header: 'Delivery Error',
    cell: (info) => (
      <span className="text-red-400 text-xs max-w-[200px] truncate block">
        {info.getValue() || '—'}
      </span>
    ),
  }),
];

export default function UploadDetails() {
  const { id } = useParams<{ id: string }>();
  const [upload, setUpload] = useState<Upload | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);

  // Send Modal States
  const [isSendModalOpen, setIsSendModalOpen] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [sending, setSending] = useState(false);

  const fetchDetails = () => {
    if (!id) return;
    Promise.all([
      uploadApi.getOne(id),
      uploadApi.getContacts(id, 1, 500),
    ])
      .then(([uploadRes, contactsRes]) => {
        setUpload(uploadRes.data);
        setContacts(contactsRes.data.contacts);
      })
      .catch((err) => {
        toast.error('Failed to load details');
      });
  };

  useEffect(() => {
    if (!id) return;
    
    // Initial fetch
    Promise.all([
      uploadApi.getOne(id),
      uploadApi.getContacts(id, 1, 500),
    ])
      .then(([uploadRes, contactsRes]) => {
        setUpload(uploadRes.data);
        setContacts(contactsRes.data.contacts);
      })
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!id) return;
    
    // Auto-refresh while processing
    const interval = setInterval(() => {
      if (upload?.status === 'processing') {
        fetchDetails();
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [id, upload?.status]);

  const handleOpenSendModal = async () => {
    try {
      const res = await templateApi.getAll();
      setTemplates(res.data);
      if (res.data.length > 0) {
        setSelectedTemplateId(res.data[0].id);
      }
      setIsSendModalOpen(true);
    } catch {
      toast.error('Failed to load templates');
    }
  };

  const handleStartSend = async () => {
    if (!id || !selectedTemplateId) return;
    setSending(true);
    try {
      await uploadApi.startSend(id, selectedTemplateId);
      toast.success('Email sending initiated!');
      setIsSendModalOpen(false);
      fetchDetails();
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Failed to initiate send');
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-brand-500 animate-spin" />
      </div>
    );
  }

  if (!upload) {
    return <div className="text-gray-500">Upload not found</div>;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/uploads/new" className="p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors">
            <ArrowLeft className="w-5 h-5 text-gray-400" />
          </Link>
          <div>
            <h1 className="page-title">Upload Details</h1>
            <p className="text-gray-500 text-sm mt-1">
              File: {upload.originalName} {upload.template && `• Active Template: ${upload.template.name}`}
            </p>
          </div>
        </div>

        <div>
          {upload.status === 'idle' && (
            <button
              onClick={handleOpenSendModal}
              className="btn-primary flex items-center gap-2 text-sm font-medium"
            >
              <Play className="w-4 h-4" />
              Send Email Template
            </button>
          )}
        </div>
      </div>

      {/* Processing indicator */}
      {upload.status === 'processing' && (
        <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4 flex items-center gap-3">
          <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />
          <p className="text-sm text-blue-400">
            Sending emails in progress... Page will auto-refresh every 5 seconds.
          </p>
        </div>
      )}

      {/* File Stats Summary */}
      <div className="space-y-2">
        <h2 className="section-title text-sm text-gray-400">Excel Summary</h2>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <InfoCard label="Total Rows" value={upload.totalRows} />
          <InfoCard label="Valid" value={upload.validEmails} color="text-emerald-400" />
          <InfoCard label="Invalid" value={upload.invalidEmails} color="text-red-400" />
          <InfoCard label="Duplicates" value={upload.duplicateEmails} color="text-amber-400" />
          <InfoCard label="Unsubscribed" value={upload.unsubscribedEmails} color="text-gray-400" />
        </div>
      </div>

      {/* Delivery Progress Stats */}
      {upload.status !== 'idle' && (
        <div className="space-y-2">
          <h2 className="section-title text-sm text-gray-400">Delivery Status</h2>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatsCard
              title="Total Recipients"
              value={upload.totalCount}
              icon={<Mail className="w-5 h-5" />}
              color="indigo"
            />
            <StatsCard
              title="Sent"
              value={upload.sentCount}
              icon={<Send className="w-5 h-5" />}
              color="emerald"
            />
            <StatsCard
              title="Failed"
              value={upload.failedCount}
              icon={<XCircle className="w-5 h-5" />}
              color="rose"
            />
            <StatsCard
              title="Pending"
              value={upload.pendingCount}
              icon={<Clock className="w-5 h-5" />}
              color="amber"
            />
            <StatsCard
              title="Skipped"
              value={upload.skippedCount}
              icon={<Ban className="w-5 h-5" />}
              color="indigo"
            />
          </div>
        </div>
      )}

      {/* Contacts Table */}
      <div className="space-y-4">
        <h2 className="section-title">Contacts List</h2>
        <ReportTable data={contacts} columns={columns} pageSize={25} />
      </div>

      {/* Send Template Modal */}
      {isSendModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fade-in">
          <div className="glass-card max-w-md w-full p-6 space-y-6 relative border border-white/10 animate-scale-in">
            <button
              onClick={() => setIsSendModalOpen(false)}
              className="absolute right-4 top-4 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors text-gray-400"
            >
              <X className="w-4 h-4" />
            </button>

            <div>
              <h3 className="text-xl font-bold text-white">Send Email Template</h3>
              <p className="text-sm text-gray-400 mt-1">
                Select a template to send to the {upload.validEmails} valid contacts in this list.
              </p>
            </div>

            {templates.length === 0 ? (
              <div className="text-center py-4 space-y-3">
                <p className="text-sm text-gray-500">You don't have any templates yet.</p>
                <Link
                  to="/templates/create"
                  className="btn-secondary inline-block text-xs"
                >
                  Create a Template
                </Link>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-2">
                  <label htmlFor="templateSelect" className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Choose Template
                  </label>
                  <select
                    id="templateSelect"
                    value={selectedTemplateId}
                    onChange={(e) => setSelectedTemplateId(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-500 transition-colors text-sm"
                  >
                    {templates.map((t) => (
                      <option key={t.id} value={t.id} className="bg-brand-950 text-white">
                        {t.name} (Subject: {t.subject})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-3 pt-2">
                  <button
                    onClick={() => setIsSendModalOpen(false)}
                    className="btn-secondary w-full text-sm py-2.5"
                    disabled={sending}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleStartSend}
                    className="btn-primary w-full text-sm py-2.5 flex items-center justify-center gap-2"
                    disabled={sending}
                  >
                    {sending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Send className="w-4 h-4" />
                    )}
                    Send Emails
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function InfoCard({ label, value, color = 'text-white' }: { label: string; value: number; color?: string }) {
  return (
    <div className="glass-card p-4 text-center">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
    </div>
  );
}
