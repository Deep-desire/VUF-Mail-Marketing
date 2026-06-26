import { useEffect, useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Mail, Search, Eye, RefreshCw, Send, AlertTriangle, Clock, Ban } from 'lucide-react';
import { createColumnHelper } from '@tanstack/react-table';
import toast from 'react-hot-toast';
import { uploadApi } from '../api/upload.api';
import { Contact } from '../types';
import ReportTable from '../components/ReportTable';
import StatusBadge from '../components/StatusBadge';
import EmailDetailModal from '../components/EmailDetailModal';

const columnHelper = createColumnHelper<Contact & { upload?: { originalName: string } }>();

type TabStatus = 'all' | 'sent' | 'failed' | 'pending' | 'skipped';

export default function Emails() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeStatus = (searchParams.get('status') as TabStatus) || 'all';

  const [contacts, setContacts] = useState<(Contact & { upload?: { originalName: string } })[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  
  // Detail Modal State
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const fetchContacts = () => {
    setLoading(true);
    uploadApi
      .getGlobalContacts({
        limit: 500,
        deliveryStatus: activeStatus === 'all' ? undefined : activeStatus,
        search: debouncedSearch.trim() || undefined,
      })
      .then((res) => {
        setContacts(res.data.contacts);
      })
      .catch(() => {
        toast.error('Failed to load delivery logs');
      })
      .finally(() => setLoading(false));
  };

  // Re-fetch when status or debounced search changes
  useEffect(() => {
    fetchContacts();
  }, [activeStatus, debouncedSearch]);

  const handleTabChange = (status: TabStatus) => {
    setSearchParams({ status });
  };

  const columns = useMemo(() => [
    columnHelper.accessor('name', {
      header: 'Recipient',
      cell: (info) => (
        <div>
          <span className="font-semibold text-white block">{info.getValue()}</span>
          <span className="text-xs text-gray-500 font-mono">{info.row.original.email}</span>
        </div>
      ),
    }),
    columnHelper.accessor('upload.originalName', {
      header: 'Campaign File',
      cell: (info) => <span className="text-gray-400">{info.getValue() || '—'}</span>,
    }),
    columnHelper.accessor('deliveryStatus', {
      header: 'Status',
      cell: (info) => <StatusBadge status={info.getValue()} />,
    }),
    columnHelper.accessor('sentAt', {
      header: 'Sent / Attempted At',
      cell: (info) => {
        const val = info.getValue();
        return val ? new Date(val).toLocaleString() : '—';
      },
    }),
    columnHelper.accessor('deliveryError', {
      header: 'Error Details',
      cell: (info) => {
        const err = info.getValue();
        return err ? (
          <span className="text-red-400 text-xs max-w-[220px] truncate block" title={err}>
            {err}
          </span>
        ) : (
          <span className="text-gray-600">—</span>
        );
      },
    }),
    columnHelper.display({
      id: 'actions',
      header: 'Actions',
      cell: (info) => {
        const contact = info.row.original;
        // Don't show detail view for completely idle contacts that have no template send attempt
        const isIdle = contact.deliveryStatus === 'idle';
        return (
          <button
            onClick={() => setSelectedContactId(contact.id)}
            disabled={isIdle}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-brand-600/10 border border-brand-500/20 text-brand-400 hover:bg-brand-600/20 hover:text-white disabled:opacity-20 disabled:cursor-not-allowed transition-all text-xs font-medium"
            title={isIdle ? 'No sent template to preview' : 'View Email Detail'}
          >
            <Eye className="w-3.5 h-3.5" />
            View
          </button>
        );
      },
    }),
  ], []);

  const tabItems: { status: TabStatus; label: string; icon: any; color: string }[] = [
    { status: 'all', label: 'All Logs', icon: Mail, color: 'text-gray-400' },
    { status: 'sent', label: 'Sent', icon: Send, color: 'text-emerald-400' },
    { status: 'failed', label: 'Failed', icon: AlertTriangle, color: 'text-rose-400' },
    { status: 'pending', label: 'Pending', icon: Clock, color: 'text-amber-400' },
    { status: 'skipped', label: 'Skipped', icon: Ban, color: 'text-gray-500' },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="page-title">Delivery Logs</h1>
          <p className="text-gray-500 text-sm mt-1">
            Track and review sent or failed marketing emails.
          </p>
        </div>
        <button
          onClick={fetchContacts}
          className="p-2 rounded-lg bg-white/5 border border-white/10 text-gray-400 hover:bg-white/10 hover:text-white transition-all"
          title="Refresh List"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Tabs and Search Bar */}
      <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
        {/* Tabs */}
        <div className="flex bg-slate-900/60 p-1 rounded-xl border border-white/5 overflow-x-auto w-full md:w-auto">
          {tabItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeStatus === item.status;
            return (
              <button
                key={item.status}
                onClick={() => handleTabChange(item.status)}
                className={`flex items-center gap-1.5 px-4 py-2.5 rounded-lg text-xs font-semibold uppercase tracking-wider transition-all whitespace-nowrap ${
                  isActive
                    ? 'bg-brand-600/20 text-brand-400 border border-brand-500/20 shadow-lg shadow-brand-500/5'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${isActive ? item.color : 'text-gray-500'}`} />
                {item.label}
              </button>
            );
          })}
        </div>

        {/* Search */}
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            placeholder="Search by name or email..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-xl pl-9 pr-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 hover:border-white/20 transition-all text-sm"
          />
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="glass-card p-6 space-y-4 animate-pulse">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="flex gap-4 items-center">
              <div className="h-10 bg-white/10 rounded-xl flex-1" />
              <div className="h-6 bg-white/10 rounded w-24" />
              <div className="h-6 bg-white/10 rounded w-16" />
            </div>
          ))}
        </div>
      ) : (
        <ReportTable data={contacts} columns={columns} pageSize={25} />
      )}

      {/* Email Detail Modal */}
      {selectedContactId && (
        <EmailDetailModal
          contactId={selectedContactId}
          onClose={() => setSelectedContactId(null)}
        />
      )}
    </div>
  );
}
