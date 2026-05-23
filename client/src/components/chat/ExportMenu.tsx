import { useState, useRef, useEffect } from 'react';
import type { ChatMessage } from '../../types/message';
import { formatTime } from './utils';

interface Props {
  messages: ChatMessage[];
  workspaceName?: string;
}

export default function ExportMenu({ messages, workspaceName }: Props) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const exportMarkdown = () => {
    const name = workspaceName || 'Roundtable';
    const date = new Date().toLocaleDateString();
    const usernames = [...new Set(messages.filter(m => m.role === 'user' && m.username).map(m => m.display_name || m.username))];

    let md = `# ${name} — Conversation Export\n`;
    md += `**Date:** ${date} | **Participants:** ${usernames.join(', ') || 'N/A'}\n\n---\n\n`;

    for (const msg of messages) {
      if (msg.role === 'system') continue;
      if (msg.role === 'tool') {
        // Summarize tool results instead of raw JSON
        const toolLabel = msg.tool_name?.replace(/_/g, ' ') || 'tool';
        md += `🔧 *[Tool: ${toolLabel}]*\n\n`;
        continue;
      }
      const sender = msg.role === 'assistant' ? '🤖 **AI Assistant**' : `**${msg.display_name || msg.username || 'User'}**`;
      const time = formatTime(msg.created_at);
      md += `${sender} (${time}):\n${msg.content}\n\n`;
    }

    navigator.clipboard.writeText(md).then(() => {
      setOpen(false);
    });
  };

  const exportPDF = async () => {
    setOpen(false);
    try {
      const { default: html2canvas } = await import('html2canvas');
      const { jsPDF } = await import('jspdf');

      const chatEl = document.querySelector('.messages-container') as HTMLElement;
      if (!chatEl) return;

      const canvas = await html2canvas(chatEl, {
        backgroundColor: '#0a0b0f',
        scale: 2,
        useCORS: true,
        logging: false,
      });

      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 10;
      const contentWidth = pageWidth - margin * 2;

      // Header
      pdf.setFontSize(16);
      pdf.setTextColor(228, 228, 231);
      pdf.text(workspaceName || 'Roundtable', margin, margin + 8);
      pdf.setFontSize(9);
      pdf.setTextColor(113, 113, 122);
      pdf.text(new Date().toLocaleString(), margin, margin + 14);

      const headerHeight = 20;
      const imgWidth = contentWidth;
      const imgHeight = (canvas.height / canvas.width) * imgWidth;

      let yPos = margin + headerHeight;
      let remainingHeight = imgHeight;
      let srcY = 0;

      while (remainingHeight > 0) {
        const availableHeight = pageHeight - yPos - margin;
        const sliceHeight = Math.min(availableHeight, remainingHeight);
        const sliceCanvas = document.createElement('canvas');
        sliceCanvas.width = canvas.width;
        sliceCanvas.height = (sliceHeight / imgWidth) * canvas.width;

        const ctx = sliceCanvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(
            canvas,
            0, srcY, canvas.width, sliceCanvas.height,
            0, 0, canvas.width, sliceCanvas.height
          );
          const sliceImg = sliceCanvas.toDataURL('image/png');
          pdf.addImage(sliceImg, 'PNG', margin, yPos, imgWidth, sliceHeight);
        }

        remainingHeight -= sliceHeight;
        srcY += sliceCanvas.height;

        if (remainingHeight > 0) {
          pdf.addPage();
          yPos = margin;
        }
      }

      const filename = `${(workspaceName || 'roundtable').replace(/\s+/g, '_').toLowerCase()}_${new Date().toISOString().slice(0, 10)}.pdf`;
      pdf.save(filename);
    } catch (err) {
      console.error('PDF export failed:', err);
    }
  };

  return (
    <div className="export-menu-wrapper" ref={menuRef}>
      <button
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen(!open)}
        title="Export conversation"
      >
        📤
      </button>
      {open && (
        <div className="export-dropdown">
          <button className="export-option" onClick={exportPDF}>
            <span className="export-option-icon">📄</span>
            <span>
              <strong>Export PDF</strong>
              <small>Download as document</small>
            </span>
          </button>
          <button className="export-option" onClick={exportMarkdown}>
            <span className="export-option-icon">📋</span>
            <span>
              <strong>Copy Markdown</strong>
              <small>Copy to clipboard</small>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
