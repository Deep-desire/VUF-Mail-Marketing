import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle, XCircle, Copy, AlertCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import FileUpload from '../components/FileUpload';
import { uploadApi } from '../api/upload.api';
import { Upload } from '../types';

export default function UploadExcel() {
  const navigate = useNavigate();
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<Upload | null>(null);

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const res = await uploadApi.uploadExcel(file);
      setResult(res.data);
      toast.success('File uploaded and processed!');
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="page-title">Upload Excel</h1>
        <p className="text-gray-500 mt-1">Upload a .xlsx file with contacts</p>
      </div>

      <div className="max-w-2xl">
        <FileUpload onFileSelect={handleUpload} isUploading={uploading} />
      </div>

      {/* Upload Result */}
      {result && (
        <div className="max-w-2xl animate-slide-up">
          <div className="glass-card p-6 space-y-4">
            <h2 className="section-title flex items-center gap-2">
              <CheckCircle className="w-5 h-5 text-emerald-400" />
              Upload Summary
            </h2>

            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <SummaryItem label="Total Rows" value={result.totalRows} color="text-white" />
              <SummaryItem label="Valid" value={result.validEmails} color="text-emerald-400" />
              <SummaryItem label="Invalid" value={result.invalidEmails} color="text-red-400" />
              <SummaryItem label="Duplicates" value={result.duplicateEmails} color="text-amber-400" />
              <SummaryItem label="Unsubscribed" value={result.unsubscribedEmails} color="text-gray-400" />
            </div>

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => navigate(`/uploads/${result.id}`)}
                className="btn-primary text-sm"
              >
                View Details
              </button>
              <button
                onClick={() => {
                  setResult(null);
                }}
                className="btn-secondary text-sm"
              >
                Upload Another
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryItem({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-white/5 rounded-xl p-3 text-center">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-xl font-bold ${color}`}>{value}</p>
    </div>
  );
}
