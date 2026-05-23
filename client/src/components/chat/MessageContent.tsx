import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeBlock from './CodeBlock';
import ChartRenderer from './ChartRenderer';
import type { ChartResult } from '../../types/message';

interface Props { content: string; }

/**
 * Extract text content from React children, which may be strings,
 * arrays, or React elements (e.g. from rehype-highlight spans).
 */
function extractText(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object' && node !== null) {
    const el = node as { props?: { children?: unknown } };
    if (el.props?.children != null) return extractText(el.props.children);
  }
  return '';
}

export default function MessageContent({ content }: Props) {
  const processed = useMemo(() => content, [content]);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '');
          const lang = match?.[1];
          const isBlock = !!(props as Record<string, unknown>).node &&
            ((props as Record<string, unknown>).node as { position?: { start: { line: number }; end: { line: number } } })?.position?.start.line !==
            ((props as Record<string, unknown>).node as { position?: { start: { line: number }; end: { line: number } } })?.position?.end.line;

          // Chart block: ```chart { ...json config... } ```
          if (lang === 'chart') {
            try {
              const raw = extractText(children).trim();
              const config = JSON.parse(raw) as ChartResult;
              if (config.chartType && config.labels && config.datasets) {
                return <ChartRenderer config={config} />;
              }
            } catch {
              // Fall through to code block if JSON is invalid
            }
          }

          if (match || isBlock) {
            return (
              <CodeBlock language={lang || 'plaintext'}>
                {extractText(children)}
              </CodeBlock>
            );
          }
          return <code className={className} {...props}>{children}</code>;
        },
        pre({ children }) {
          return <>{children}</>;
        },
      }}
    >
      {processed}
    </ReactMarkdown>
  );
}
