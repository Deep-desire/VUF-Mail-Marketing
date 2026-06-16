interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export default function TemplateEditor({ value, onChange, placeholder }: Props) {
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
    </div>
  );
}
