import { useState } from 'react';
import { Maximize2, X } from 'lucide-react';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export default function TemplateEditor({ value, onChange, placeholder }: Props) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  const insertVariable = (variable: string) => {
    onChange(value + `{{${variable}}}`);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500">Insert variable:</span>
        {['name', 'email', 'unsubscribeLink'].map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => insertVariable(v)}
            className="px-2 py-1 text-xs bg-brand-500/20 text-brand-400 rounded-lg border border-brand-500/20
                       hover:bg-brand-500/30 transition-all duration-200"
          >
            {`{{${v}}}`}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* HTML Editor */}
        <div className="flex flex-col">
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            rows={15}
            className="input-field font-mono text-sm resize-y min-h-[350px] flex-1"
          />
        </div>

        {/* Live Preview */}
        <div className="flex flex-col border border-white/10 rounded-xl bg-[#0b0c16] overflow-hidden min-h-[350px]">
          <div className="px-4 py-2 border-b border-white/10 bg-white/5 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Live Preview</span>
            <button
              type="button"
              onClick={() => setIsFullscreen(true)}
              className="p-1 px-2.5 rounded-lg bg-white/5 hover:bg-white/10 hover:text-white transition-colors text-gray-400 flex items-center gap-1.5 text-xs font-semibold"
              title="Full Screen Preview"
            >
              <Maximize2 className="w-3.5 h-3.5" />
              <span>Full Screen</span>
            </button>
          </div>
          <div className="flex-1 bg-white p-2 min-h-[300px]">
            <iframe
              srcDoc={value || `<div style="color: #666; font-family: sans-serif; text-align: center; padding: 40px; font-size: 14px;">No HTML content. Type code on the left to preview...</div>`}
              title="HTML Email Preview"
              className="w-full h-full border-0 min-h-[320px] rounded-lg"
              sandbox="allow-same-origin"
            />
          </div>
        </div>
      </div>

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
              <iframe
                srcDoc={value || `<div style="color: #666; font-family: sans-serif; text-align: center; padding: 40px; font-size: 14px;">No HTML content. Type code in the editor to preview...</div>`}
                title="Full Screen Email Preview"
                className="w-full h-full border-0 rounded-lg"
                sandbox="allow-same-origin"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
