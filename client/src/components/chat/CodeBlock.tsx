import { useCallback, useRef } from 'react';

interface Props { language: string; children: string; }

export default function CodeBlock({ language, children }: Props) {
  const codeRef = useRef<HTMLElement>(null);

  const handleCopy = useCallback(() => {
    if (codeRef.current) {
      navigator.clipboard.writeText(codeRef.current.textContent || '');
    }
  }, []);

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span>{language}</span>
        <button className="code-copy-btn" onClick={handleCopy}>📋 Copy</button>
      </div>
      <pre><code ref={codeRef} className={`language-${language}`}>{children}</code></pre>
    </div>
  );
}
