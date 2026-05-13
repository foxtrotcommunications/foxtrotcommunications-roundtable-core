import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import CodeBlock from './CodeBlock';

interface Props { content: string; }

export default function MessageContent({ content }: Props) {
  // Highlight @mentions in the raw text before markdown parsing
  const processed = useMemo(() => content, [content]);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
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
                {String(children).replace(/\n$/, '')}
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
