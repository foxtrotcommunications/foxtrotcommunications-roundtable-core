import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/globals.css';

// Sentry client-side error tracking — set VITE_SENTRY_DSN to enable
if (import.meta.env.VITE_SENTRY_DSN) {
  // @ts-ignore — @sentry/react is an optional dependency
  import('@sentry/react').then((Sentry: any) => {
    Sentry.init({
      dsn: import.meta.env.VITE_SENTRY_DSN,
      environment: import.meta.env.MODE,
      tracesSampleRate: 0.1,
    });
    console.log('[Sentry] Client error tracking enabled');
  });
}

// Detect demo/embed mode — when loaded in an iframe, hide toolbar
declare global { interface Window { __ROUNDTABLE_DEMO__?: boolean; } }
window.__ROUNDTABLE_DEMO__ = window.self !== window.top;

// Apply saved theme before first paint to prevent flash
(function initTheme() {
  const saved = localStorage.getItem('rt-theme') || 'system';
  const resolved = saved === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : saved;
  document.documentElement.setAttribute('data-theme', resolved);
})();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
