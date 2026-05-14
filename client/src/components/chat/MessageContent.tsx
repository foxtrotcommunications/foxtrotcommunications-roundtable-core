import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeBlock from './CodeBlock';

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
  // Highlight @mentions in the raw text before markdown parsing
  const processed = useMemo(() => content, [content]);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Custom code block renderer with copy button
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '');
          const isBlock = !!(props as Record<string, unknown>).node &&
            ((props as Record<string, unknown>).node as { position?: { start: { line: number }; end: { line: number } } })?.position?.start.line !==
            ((props as Record<string, unknown>).node as { position?: { start: { line: number }; end: { line: number } } })?.position?.end.line;

          if (match || isBlock) {
            return (
              <CodeBlock language={match?.[1] || 'plaintext'}>
                {extractText(children)}
              </CodeBlock>
            );
          }
          return <code className={className} {...props}>{children}</code>;
        },
        // Render pre as-is (CodeBlock handles the wrapper)
        pre({ children }) {
          return <>{children}</>;
        },
      }}
    >
      {processed}
    </ReactMarkdown>
  );
}
