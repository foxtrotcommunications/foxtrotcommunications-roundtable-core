import { useState, useEffect } from 'react';

type Theme = 'light' | 'dark' | 'system';

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: Theme) {
  const resolved = theme === 'system' ? getSystemTheme() : theme;
  document.documentElement.setAttribute('data-theme', resolved);
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    return (localStorage.getItem('rt-theme') as Theme) || 'system';
  });

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem('rt-theme', theme);
  }, [theme]);

  // Listen for system theme changes when 'system' is selected
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const options: { value: Theme; icon: string; label: string }[] = [
    { value: 'light', icon: '☀️', label: 'Light' },
    { value: 'dark', icon: '🌙', label: 'Dark' },
    { value: 'system', icon: '💻', label: 'System' },
  ];

  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Color scheme">
      {options.map(opt => (
        <button
          key={opt.value}
          className={`theme-toggle-btn${theme === opt.value ? ' active' : ''}`}
          onClick={() => setTheme(opt.value)}
          title={opt.label}
          role="radio"
          aria-checked={theme === opt.value}
        >
          <span className="theme-toggle-icon">{opt.icon}</span>
          <span className="theme-toggle-label">{opt.label}</span>
        </button>
      ))}
    </div>
  );
}
