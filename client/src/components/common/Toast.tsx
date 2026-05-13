import { useState, useCallback } from 'react';
import type { ReactNode } from 'react';

export interface ToastItem {
  id: number;
  message: string;
  type: 'info' | 'success' | 'error';
}

export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const addToast = useCallback((message: string, type: ToastItem['type'] = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return { toasts, addToast, removeToast };
}

interface Props { toasts: ToastItem[]; onRemove: (id: number) => void; }

export default function Toast({ toasts, onRemove }: Props): ReactNode {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.type}`} onClick={() => onRemove(t.id)}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
