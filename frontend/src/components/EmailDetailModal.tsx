import { useEffect, useState } from 'react';
import { X, Loader2, Mail, Calendar, FileText, AlertCircle, Eye, AlignLeft } from 'lucide-react';
import StatusBadge from './StatusBadge';
import { uploadApi } from '../api/upload.api';
import toast from 'react-hot-toast';

interface Props {
  contactId: string;
  onClose: () => void;
}

interface DetailData {
  contact: {
    id: string;
    name: string;
    email: string;
    status: string;
    error: string | null;
    createdAt: string;
  };
  delivery: {
    status: string;
    error: string | null;
    sentAt: string | null;
  };
  template: {
    id: string | null;
    name: string;
    subject: string;
    htmlBody: string;
    plainTextBody: string;
  };
  upload: {
    id: string;
    fileName: string;
  };
}

export default function EmailDetailModal({ contactId, onClose }: Props) {
  const [data, setData] = useState<DetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'html' | 'text'>('html');
  const [iframeHeight, setIframeHeight] = useState('350px');

  useEffect(() => {
    uploadApi
      .getContactDetail(contactId)
      .then((res) => {
        setData(res.data);
      })
      .catch((err) => {
        toast.error('Failed to load email details');
        onClose();
      })
      .finally(() => setLoading(false));
  }, [contactId, onClose]);

  const handleIframeLoad = (e: React.SyntheticEvent<HTMLIFrameElement>) => {
    const iframe = e.currentTarget;
    const updateHeight = () => {
      if (iframe.contentWindow && iframe.contentDocument) {
        const body = iframe.contentDocument.body;
        const html = iframe.contentDocument.documentElement;
        const height = Math.max(
          body.scrollHeight,
          body.offsetHeight,
          html.clientHeight,
          html.scrollHeight,
          html.offsetHeight
        );
        // Constrain height to a sensible range
        setIframeHeight(`${Math.min(Math.max(height, 250), 500)}px`);
      }
    };
    
    updateHeight();
    setTimeout(updateHeight, 200);
    setTimeout(updateHeight, 1000);
  };

  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fade-in">
      <div className="glass-card max-w-3xl w-full p-6 space-y-6 relative border border-white/10 flex flex-col max-h-[90vh] shadow-2xl animate-scale-in">
        
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute right-4 top-4 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
        >
          <X className="w-4.5 h-4.5" />
        </button>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 space-y-4">
            <Loader2 className="w-8 h-8 text-brand-500 animate-spin" />
            <p className="text-sm text-gray-400">Loading email details...</p>
          </div>
        ) : data ? (
          <>
            {/* Modal Header */}
            <div>
              <h3 className="text-xl font-bold text-white flex items-center gap-2">
                <Mail className="w-5 h-5 text-brand-400" />
                Email Delivery Details
              </h3>
              <p className="text-xs text-gray-500 mt-1">
                Campaign Upload: <span className="font-semibold text-gray-400">{data.upload.fileName}</span>
              </p>
            </div>

            {/* Email Envelope Header */}
            <div className="bg-slate-950/60 border border-white/5 rounded-xl p-4 space-y-3 text-sm text-gray-300">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 pb-2">
                <div className="flex items-center gap-2">
                  <span className="text-gray-500 font-semibold w-16 text-xs uppercase tracking-wider">Subject:</span>
                  <span className="text-white font-semibold text-base">{data.template.subject || '—'}</span>
                </div>
                <StatusBadge status={data.delivery.status} size="sm" />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="space-y-1">
                  <div>
                    <span className="text-gray-500 font-semibold inline-block w-16">To:</span>
                    <span className="text-gray-200 font-medium">{data.contact.name}</span>{' '}
                    <span className="text-gray-400 font-mono">&lt;{data.contact.email}&gt;</span>
                  </div>
                  <div>
                    <span className="text-gray-500 font-semibold inline-block w-16">From:</span>
                    <span className="text-gray-300">Vishv Umiya Foundation &lt;marketing@vuf.org&gt;</span>
                  </div>
                </div>

                <div className="space-y-1 md:text-right">
                  {data.delivery.sentAt ? (
                    <div className="flex items-center md:justify-end gap-1.5 text-gray-400">
                      <Calendar className="w-3.5 h-3.5" />
                      <span>{new Date(data.delivery.sentAt).toLocaleString()}</span>
                    </div>
                  ) : (
                    <span className="text-gray-500 italic">Not sent yet</span>
                  )}
                  {data.template.name && (
                    <div className="flex items-center md:justify-end gap-1.5 text-gray-400">
                      <FileText className="w-3.5 h-3.5" />
                      <span>Template: {data.template.name}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Delivery Error Notice */}
            {data.delivery.status === 'failed' && data.delivery.error && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex gap-3 items-start">
                <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                <div>
                  <h4 className="font-semibold text-red-400 text-sm">Delivery Error</h4>
                  <p className="text-xs text-red-300/80 mt-1 font-mono">{data.delivery.error}</p>
                </div>
              </div>
            )}

            {/* Content Tabs */}
            <div className="flex border-b border-white/5">
              <button
                onClick={() => setActiveTab('html')}
                className={`px-4 py-2 text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5 border-b-2 transition-all ${
                  activeTab === 'html'
                    ? 'border-brand-500 text-brand-400 bg-brand-500/5'
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
              >
                <Eye className="w-4 h-4" />
                HTML Preview
              </button>
              <button
                onClick={() => setActiveTab('text')}
                className={`px-4 py-2 text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5 border-b-2 transition-all ${
                  activeTab === 'text'
                    ? 'border-brand-500 text-brand-400 bg-brand-500/5'
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
              >
                <AlignLeft className="w-4 h-4" />
                Plain Text View
              </button>
            </div>

            {/* Content Body Preview */}
            <div className="flex-1 min-h-[300px] flex flex-col bg-slate-950/20 border border-white/5 rounded-xl overflow-hidden">
              {activeTab === 'html' ? (
                data.template.htmlBody ? (
                  <div className="flex-1 bg-white rounded-lg shadow-inner m-4 overflow-hidden self-stretch flex flex-col">
                    <iframe
                      title="Personalized Email HTML body preview"
                      onLoad={handleIframeLoad}
                      style={{ height: iframeHeight }}
                      srcDoc={`
                        <!DOCTYPE html>
                        <html>
                          <head>
                            <meta charset="utf-8">
                            <style>
                              body {
                                font-family: 'Inter', system-ui, -apple-system, sans-serif;
                                color: #1e293b;
                                line-height: 1.6;
                                background-color: #ffffff;
                                margin: 0;
                                padding: 20px;
                              }
                              ::-webkit-scrollbar {
                                width: 6px;
                                height: 6px;
                              }
                              ::-webkit-scrollbar-track {
                                background: #f1f5f9;
                              }
                              ::-webkit-scrollbar-thumb {
                                background: #cbd5e1;
                                border-radius: 3px;
                              }
                            </style>
                          </head>
                          <body>
                            ${data.template.htmlBody}
                          </body>
                        </html>
                      `}
                      className="w-full border-0 block flex-1"
                    />
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
                    No HTML template body available
                  </div>
                )
              ) : (
                <div className="flex-1 p-4 overflow-auto">
                  <pre className="whitespace-pre-wrap text-sm text-gray-300 font-mono bg-slate-950/60 p-4 rounded-xl border border-white/5 max-h-[350px] overflow-y-auto">
                    {data.template.plainTextBody || 'No plain text template body available'}
                  </pre>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={onClose}
                className="btn-secondary text-sm py-2 px-6"
              >
                Close
              </button>
            </div>
          </>
        ) : (
          <div className="text-center py-10 text-gray-400">
            Failed to load email details.
          </div>
        )}
      </div>
    </div>
  );
}
