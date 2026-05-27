import { useState, useEffect } from 'react';

const STORAGE_KEY = 'rt-onboarded';

interface Props {
  onDismiss: () => void;
  onTryPrompt: (prompt: string) => void;
}

export default function OnboardingTooltip({ onDismiss, onTryPrompt }: Props) {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    // Only show on first visit
    if (localStorage.getItem(STORAGE_KEY)) return;
    // Small delay so the chat renders first
    const timer = setTimeout(() => setVisible(true), 800);
    return () => clearTimeout(timer);
  }, []);

  const dismiss = () => {
    setVisible(false);
    localStorage.setItem(STORAGE_KEY, 'true');
    onDismiss();
  };

  const tryIt = () => {
    dismiss();
    onTryPrompt('@ai What tools do you have? Give me a quick overview.');
  };

  if (!visible) return null;

  const steps = [
    {
      title: '👋 Welcome to Roundtable',
      body: (
        <>
          <p>This is a <strong>multiplayer AI workspace</strong>. You and your team chat together — and the AI joins when you need it.</p>
          <p className="onboarding-highlight">
            Type <span className="mention mention-ai">@ai</span> to talk to the AI assistant.
            <br />
            Messages <em>without</em> @ai go to your teammates only.
          </p>
        </>
      ),
    },
    {
      title: '🛠️ What can the AI do?',
      body: (
        <>
          <div className="onboarding-capabilities">
            <div className="onboarding-cap"><span>🗄️</span> Query your databases</div>
            <div className="onboarding-cap"><span>📊</span> Generate charts & visualizations</div>
            <div className="onboarding-cap"><span>💻</span> Write & run code</div>
            <div className="onboarding-cap"><span>🌐</span> Search the web</div>
            <div className="onboarding-cap"><span>⬇️</span> Export results as CSV</div>
            <div className="onboarding-cap"><span>🧮</span> Calculate & analyze</div>
          </div>
        </>
      ),
    },
  ];

  const current = steps[step];

  return (
    <>
      <div className="onboarding-backdrop" onClick={dismiss} />
      <div className="onboarding-tooltip">
        <button className="onboarding-close" onClick={dismiss} aria-label="Dismiss">×</button>
        <div className="onboarding-step-indicator">
          {steps.map((_, i) => (
            <span key={i} className={`onboarding-dot ${i === step ? 'active' : ''}`} />
          ))}
        </div>
        <h3 className="onboarding-title">{current.title}</h3>
        <div className="onboarding-body">{current.body}</div>
        <div className="onboarding-actions">
          {step < steps.length - 1 ? (
            <>
              <button className="onboarding-btn-secondary" onClick={dismiss}>Skip</button>
              <button className="onboarding-btn-primary" onClick={() => setStep(step + 1)}>Next →</button>
            </>
          ) : (
            <>
              <button className="onboarding-btn-secondary" onClick={dismiss}>Got it</button>
              <button className="onboarding-btn-primary" onClick={tryIt}>Try it now ⚡</button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
