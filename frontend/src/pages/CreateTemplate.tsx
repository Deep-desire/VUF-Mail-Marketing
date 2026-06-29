import { useEffect, useState, useMemo, memo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { ArrowLeft, Save, SendHorizontal, Loader2, Maximize2, X, Paperclip, File, Trash2, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import TemplateEditor from '../components/TemplateEditor';
import { templateApi } from '../api/template.api';
import { TemplateAttachment } from '../types';

interface TemplateForm {
  name: string;
  subject: string;
  htmlBody: string;
  plainTextBody: string;
}

// Memoized Live Preview to avoid iframe resets on parent state changes
const LivePreview = memo(({ htmlBody, isFullScreen = false }: { htmlBody: string; isFullScreen?: boolean }) => {
  return (
    <iframe
      srcDoc={htmlBody || `<div style="color: #666; font-family: sans-serif; text-align: center; padding: ${isFullScreen ? '40px' : '60px'}; font-size: 14px;">No HTML content. Type code on the left to preview...</div>`}
      title={isFullScreen ? 'Full Screen Email Preview' : 'HTML Email Preview'}
      className="w-full h-full border-0 rounded-lg"
      sandbox="allow-same-origin"
    />
  );
});

// Colocated SendTestForm component to isolate typing states from the parent template editor
const SendTestForm = memo(({ templateId }: { templateId: string }) => {
  const [testEmail, setTestEmail] = useState('');
  const [testing, setTesting] = useState(false);

  const handleSendTest = async () => {
    if (!templateId || !testEmail) {
      toast.error('Enter a test email address');
      return;
    }
    setTesting(true);
    try {
      await templateApi.sendTest(templateId, testEmail);
      toast.success('Test email sent successfully!');
    } catch {
      toast.error('Failed to send test email');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="glass-card p-6">
      <h3 className="section-title mb-4">Send Test Email</h3>
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label htmlFor="test-email" className="label-text">Test Email Address</label>
          <input
            id="test-email"
            type="email"
            className="input-field"
            placeholder="test@example.com"
            value={testEmail}
            onChange={(e) => setTestEmail(e.target.value)}
          />
        </div>
        <button
          type="button"
          onClick={handleSendTest}
          disabled={testing || !testEmail}
          className="btn-secondary flex items-center gap-2 whitespace-nowrap"
        >
          {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <SendHorizontal className="w-4 h-4" />}
          Send Test
        </button>
      </div>
    </div>
  );
});

export default function CreateTemplate() {
  const navigate = useNavigate();
  const { id } = useParams();
  const isEdit = Boolean(id);
  const [saving, setSaving] = useState(false);
  const [htmlBody, setHtmlBody] = useState('');
  const [plainTextBody, setPlainTextBody] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Attachment states
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [existingAttachments, setExistingAttachments] = useState<TemplateAttachment[]>([]);
  const [deleteAttachmentIds, setDeleteAttachmentIds] = useState<string[]>([]);

  const { register, handleSubmit, setValue, formState: { errors } } = useForm<TemplateForm>();

  useEffect(() => {
    if (id) {
      templateApi.getOne(id).then((res) => {
        const t = res.data;
        setValue('name', t.name);
        setValue('subject', t.subject);
        setHtmlBody(t.htmlBody);
        setPlainTextBody(t.plainTextBody);
        setExistingAttachments(t.attachments || []);
      });
    }
  }, [id]);

  const onSubmit = async (data: TemplateForm) => {
    setSaving(true);
    try {
      const formData = new FormData();
      formData.append('name', data.name);
      formData.append('subject', data.subject);
      formData.append('htmlBody', htmlBody);
      formData.append('plainTextBody', plainTextBody);

      if (isEdit) {
        formData.append('deleteAttachmentIds', JSON.stringify(deleteAttachmentIds));
      }

      selectedFiles.forEach((file) => {
        formData.append('attachments', file);
      });

      if (isEdit && id) {
        await templateApi.update(id, formData);
        toast.success('Template updated!');
      } else {
        await templateApi.create(formData);
        toast.success('Template created!');
      }
      navigate('/templates');
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Failed to save template');
    } finally {
      setSaving(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const filesArray = Array.from(e.target.files);
      const isTooLarge = filesArray.some((file) => file.size > 10 * 1024 * 1024);
      if (isTooLarge) {
        toast.error('One or more files exceed the 10MB limit');
        return;
      }
      setSelectedFiles((prev) => [...prev, ...filesArray]);
    }
  };

  const handleRemoveSelectedFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleRemoveExistingAttachment = (attachmentId: string) => {
    setDeleteAttachmentIds((prev) => [...prev, attachmentId]);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <button onClick={() => navigate('/templates')} className="p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors">
          <ArrowLeft className="w-5 h-5 text-gray-400" />
        </button>
        <h1 className="page-title">{isEdit ? 'Edit Template' : 'Create Template'}</h1>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="max-w-7xl w-full grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {/* Left Column - Template Information */}
        <div className="space-y-6">
          <div className="glass-card p-6 space-y-5">
            {/* Template Name */}
            <div>
              <label htmlFor="template-name" className="label-text">Template Name</label>
              <input
                id="template-name"
                className="input-field"
                placeholder="e.g. Monthly Newsletter"
                {...register('name', { required: 'Name is required' })}
              />
              {errors.name && <p className="text-red-400 text-xs mt-1">{errors.name.message}</p>}
            </div>

            {/* Subject */}
            <div>
              <label htmlFor="template-subject" className="label-text">Email Subject</label>
              <input
                id="template-subject"
                className="input-field"
                placeholder="e.g. Hello {{name}}, check out our latest update!"
                {...register('subject', { required: 'Subject is required' })}
              />
              {errors.subject && <p className="text-red-400 text-xs mt-1">{errors.subject.message}</p>}
            </div>

            {/* HTML Body */}
            <div>
              <label className="label-text">HTML Body</label>
              <TemplateEditor
                value={htmlBody}
                onChange={setHtmlBody}
                placeholder="<h1>Hello {{name}}</h1><p>Your email content here...</p><p><a href='{{unsubscribeLink}}'>Unsubscribe</a></p>"
              />
            </div>

            {/* Plain Text Body */}
            <div>
              <label className="label-text">Plain Text Body</label>
              <textarea
                value={plainTextBody}
                onChange={(e) => setPlainTextBody(e.target.value)}
                placeholder="Hello {{name}}, your email content here... Unsubscribe: {{unsubscribeLink}}"
                rows={5}
                className="input-field resize-y"
              />
            </div>
          </div>

          {/* Attachments Section */}
          <div className="glass-card p-6 space-y-4">
            <h3 className="section-title flex items-center gap-2">
              <Paperclip className="w-5 h-5 text-brand-400" />
              Template Attachments
            </h3>

            {/* File Input Selector */}
            <div className="border-2 border-dashed border-white/10 hover:border-brand-500/50 rounded-xl p-6 text-center cursor-pointer transition-all hover:bg-white/5 relative">
              <input
                type="file"
                multiple
                onChange={handleFileChange}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
              <Upload className="w-8 h-8 text-gray-400 mx-auto mb-2" />
              <p className="text-sm text-gray-300 font-medium">Click or drag files here to attach</p>
              <p className="text-xs text-gray-500 mt-1">Supports PDF, Word, Excel, and Images (Max 10MB)</p>
            </div>

            {/* Attachments List */}
            {((existingAttachments && existingAttachments.length > 0) || selectedFiles.length > 0) && (
              <div className="space-y-2">
                <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider block">
                  Attached Files
                </label>
                <div className="divide-y divide-white/5 bg-white/5 rounded-xl border border-white/10 overflow-hidden">
                  {/* Existing Attachments */}
                  {existingAttachments
                    .filter((att) => !deleteAttachmentIds.includes(att.id))
                    .map((att) => (
                      <div key={att.id} className="flex items-center justify-between p-3 text-sm hover:bg-white/5 transition-colors">
                        <div className="flex items-center gap-3 truncate">
                          <File className="w-4 h-4 text-brand-400 shrink-0" />
                          <span className="text-white truncate" title={att.name}>{att.name}</span>
                          <span className="text-xs text-gray-500 shrink-0">({(att.size / 1024).toFixed(1)} KB)</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRemoveExistingAttachment(att.id)}
                          className="p-1.5 rounded-lg hover:bg-red-500/20 text-red-400 transition-colors"
                          title="Remove Attachment"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}

                  {/* New Selected Files */}
                  {selectedFiles.map((file, idx) => (
                    <div key={idx} className="flex items-center justify-between p-3 text-sm hover:bg-white/5 transition-colors">
                      <div className="flex items-center gap-3 truncate">
                        <File className="w-4 h-4 text-emerald-400 shrink-0" />
                        <span className="text-white truncate" title={file.name}>{file.name}</span>
                        <span className="text-xs text-gray-500 shrink-0">({(file.size / 1024).toFixed(1)} KB)</span>
                        <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded font-medium uppercase tracking-wider">New</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveSelectedFile(idx)}
                        className="p-1.5 rounded-lg hover:bg-red-500/20 text-red-400 transition-colors"
                        title="Remove Attachment"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-4">
            <button type="submit" disabled={saving} className="btn-primary flex items-center gap-2">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {isEdit ? 'Update Template' : 'Save Template'}
            </button>
          </div>

          {/* Send Test (only for existing templates) */}
          {isEdit && id && <SendTestForm templateId={id} />}
        </div>

        {/* Right Column - Live Preview */}
        <div className="sticky top-6 flex flex-col border border-white/10 rounded-2xl bg-[#0b0c16] overflow-hidden h-[calc(100vh-140px)] min-h-[500px]">
          <div className="px-6 py-4 border-b border-white/10 bg-white/5 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-white uppercase tracking-wider">Live Preview</h3>
              <p className="text-[10px] text-gray-400 mt-0.5">Real-time template rendering</p>
            </div>
            <button
              type="button"
              onClick={() => setIsFullscreen(true)}
              className="p-1.5 px-3 rounded-lg bg-white/5 hover:bg-white/10 hover:text-white transition-colors text-gray-400 flex items-center gap-1.5 text-xs font-semibold"
              title="Full Screen Preview"
            >
              <Maximize2 className="w-3.5 h-3.5" />
              <span>Full Screen</span>
            </button>
          </div>
          <div className="flex-1 bg-white p-4">
            <LivePreview htmlBody={htmlBody} />
          </div>
        </div>
      </form>

      {/* Full Screen Preview Modal */}
      {isFullscreen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4 md:p-8 animate-fade-in">
          <div className="bg-slate-900 border border-white/10 rounded-2xl w-full max-w-5xl h-[90vh] flex flex-col overflow-hidden animate-scale-in">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between bg-white/5">
              <div>
                <h3 className="text-lg font-bold text-white">Full Screen Template Preview</h3>
                <p className="text-xs text-gray-400 mt-0.5">Rendered email layout</p>
              </div>
              <button
                type="button"
                onClick={() => setIsFullscreen(false)}
                className="p-2 rounded-xl bg-white/5 hover:bg-white/10 hover:text-white transition-colors text-gray-400"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="flex-1 bg-white p-4">
              <LivePreview htmlBody={htmlBody} isFullScreen={true} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
