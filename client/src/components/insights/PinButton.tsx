import { useState } from 'react';
import * as api from '../../api';

interface Props {
  messageId: number;
  content: string;
}

export default function PinButton({ messageId, content }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('general');
  const [saving, setSaving] = useState(false);
  const [pinned, setPinned] = useState(false);

  const handleOpen = () => {
    // Auto-fill title from first line of content
    const firstLine = content.split('\n')[0]
      .replace(/^[@#*_~`>]+\s*/, '')  // strip markdown markers
      .replace(/\*\*/g, '')            // strip bold
      .slice(0, 80);
    setTitle(firstLine || 'Untitled Insight');
    setShowForm(true);
  };

  const handlePin = async () => {
    setSaving(true);
    try {
      await api.addInsight({
        title,
        content: content.slice(0, 2000),
        sourceMessageId: messageId,
        category,
      });
      setPinned(true);
      setShowForm(false);
      setTimeout(() => setPinned(false), 3000);
    } catch (err) {
      console.error('Failed to pin insight:', err);
    } finally {
      setSaving(false);
    }
  };

  if (pinned) {
    return <span className="pin-success">✅ Pinned</span>;
  }

  if (showForm) {
    return (
      <div className="pin-form" onClick={e => e.stopPropagation()}>
        <input
          className="pin-form-title"
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Insight title..."
          autoFocus
        />
        <select className="pin-form-category" value={category} onChange={e => setCategory(e.target.value)}>
          <option value="general">📌 General</option>
          <option value="kpi">📊 KPI</option>
          <option value="risk">⚠️ Risk</option>
          <option value="opportunity">🎯 Opportunity</option>
          <option value="decision">⚖️ Decision</option>
        </select>
        <div className="pin-form-actions">
          <button className="pin-form-submit" onClick={handlePin} disabled={saving || !title.trim()}>
            {saving ? '...' : 'Pin'}
          </button>
          <button className="pin-form-cancel" onClick={() => setShowForm(false)}>✕</button>
        </div>
      </div>
    );
  }

  return (
    <button className="pin-button" onClick={handleOpen} title="Pin as insight">
      📌
    </button>
  );
}
