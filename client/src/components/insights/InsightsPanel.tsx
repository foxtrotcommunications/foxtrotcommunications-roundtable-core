import { useState, useEffect, useCallback } from 'react';
import * as api from '../../api';
import type { Insight } from '../../types/workspace';

const CATEGORY_COLORS: Record<string, string> = {
  kpi: '#3b82f6',
  risk: '#ef4444',
  opportunity: '#22c55e',
  decision: '#a855f7',
  general: '#71717a',
};

const CATEGORY_LABELS: Record<string, string> = {
  kpi: '📊 KPI',
  risk: '⚠️ Risk',
  opportunity: '🎯 Opportunity',
  decision: '⚖️ Decision',
  general: '📌 General',
};

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export default function InsightsPanel({ isOpen, onClose }: Props) {
  const [insights, setInsights] = useState<Insight[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const loadInsights = useCallback(async () => {
    try {
      const data = await api.getInsights();
      setInsights(data);
    } catch (err) {
      console.error('Failed to load insights:', err);
    }
  }, []);

  useEffect(() => {
    if (isOpen) loadInsights();
  }, [isOpen, loadInsights]);

  const handleDelete = async (id: number) => {
    try {
      await api.deleteInsight(id);
      setInsights(prev => prev.filter(i => i.id !== id));
      setConfirmDelete(null);
    } catch (err) {
      console.error('Failed to delete insight:', err);
    }
  };

  const filtered = filter === 'all'
    ? insights
    : insights.filter(i => i.category === filter);

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    const diffDays = Math.floor(diffHrs / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  };

  return (
    <div className={`insights-panel${isOpen ? ' open' : ''}`}>
      <div className="insights-header">
        <div className="insights-title">
          <span>📌 Insights</span>
          {insights.length > 0 && <span className="insights-count">{insights.length}</span>}
        </div>
        <button className="insights-close" onClick={onClose}>✕</button>
      </div>

      <div className="insights-filters">
        {['all', 'kpi', 'risk', 'opportunity', 'decision', 'general'].map(cat => (
          <button
            key={cat}
            className={`insights-filter-chip${filter === cat ? ' active' : ''}`}
            onClick={() => setFilter(cat)}
            style={filter === cat && cat !== 'all' ? { borderColor: CATEGORY_COLORS[cat] } : {}}
          >
            {cat === 'all' ? 'All' : CATEGORY_LABELS[cat]}
          </button>
        ))}
      </div>

      <div className="insights-list">
        {filtered.length === 0 ? (
          <div className="insights-empty">
            <div className="insights-empty-icon">📌</div>
            <div className="insights-empty-text">
              {filter === 'all'
                ? 'No insights pinned yet.'
                : `No ${filter} insights.`}
            </div>
            <div className="insights-empty-hint">
              Click 📌 on any AI response to capture a key finding.
            </div>
          </div>
        ) : (
          filtered.map(insight => (
            <div key={insight.id} className="insight-card">
              <div className="insight-card-header">
                <span
                  className="insight-category-badge"
                  style={{ backgroundColor: CATEGORY_COLORS[insight.category] + '22', color: CATEGORY_COLORS[insight.category], borderColor: CATEGORY_COLORS[insight.category] + '44' }}
                >
                  {CATEGORY_LABELS[insight.category] || insight.category}
                </span>
                {confirmDelete === insight.id ? (
                  <div className="insight-delete-confirm">
                    <button className="insight-delete-yes" onClick={() => handleDelete(insight.id)}>Delete</button>
                    <button className="insight-delete-no" onClick={() => setConfirmDelete(null)}>Cancel</button>
                  </div>
                ) : (
                  <button className="insight-delete-btn" onClick={() => setConfirmDelete(insight.id)} title="Delete">🗑</button>
                )}
              </div>
              <div className="insight-card-title">{insight.title}</div>
              <div className="insight-card-content">{insight.content.length > 200 ? insight.content.slice(0, 200) + '…' : insight.content}</div>
              <div className="insight-card-meta">
                Pinned by {insight.display_name || insight.username || 'Unknown'} · {formatTime(insight.pinned_at)}
                {insight.source_message_id && (
                  <button
                    className="insight-source-link"
                    onClick={() => {
                      const el = document.querySelector(`[data-msg-id="${insight.source_message_id}"]`);
                      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }}
                  >
                    View source ↗
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
