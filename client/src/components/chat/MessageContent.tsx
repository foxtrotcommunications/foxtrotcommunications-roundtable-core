import { useMemo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeBlock from './CodeBlock';
import ChartRenderer from './ChartRenderer';
import MermaidRenderer from './MermaidRenderer';
import CollapsibleBlock from './CollapsibleBlock';
import { MermaidBlock, TableBlock } from './DownloadableBlocks';
import type { ChartResult } from '../../types/message';

interface Props {
  content: string;
  streaming?: boolean;
}

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

/** Replace @mentions in a text string with styled span elements */
function renderMentions(text: string): ReactNode[] {
  // Match @word (single-word like @ai) or @Capitalized Word(s) for display names
  // e.g. @ai, @Brady, @Brady Bastian, @AI Assistant
  const parts = text.split(/(@[A-Za-z][\w-]*(?:\s+[A-Z][\w-]*)*)/g);
  return parts.map((part, i) => {
    const mentionMatch = part.match(/^@([A-Za-z][\w-]*(?:\s+[A-Z][\w-]*)*)$/);
    if (mentionMatch) {
      const username = mentionMatch[1];
      const isAi = username.toLowerCase() === 'ai';
      return (
        <span key={i} className={`mention${isAi ? ' mention-ai' : ''}`}>
          {part}
        </span>
      );
    }
    return part;
  });
}

/** Recursively process React children to add mention styling */
function processMentions(children: ReactNode): ReactNode {
  if (typeof children === 'string') return renderMentions(children);
  if (Array.isArray(children)) return children.map((c, i) => <span key={i}>{processMentions(c)}</span>);
  return children;
}

export default function MessageContent({ content, streaming }: Props) {
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
          if (lang === 'chart' && !streaming) {
            try {
              const raw = extractText(children).trim();
              const config = JSON.parse(raw) as ChartResult;
              if (config.chartType && config.labels && config.datasets) {
                return (
                  <CollapsibleBlock label={config.title || 'Chart'} icon="📊">
                    <ChartRenderer config={config} />
                  </CollapsibleBlock>
                );
              }
            } catch {
              // Fall through to code block if JSON is invalid
            }
          }

          // Mermaid diagram block: ```mermaid ... ```
          if (lang === 'mermaid' && !streaming) {
            let raw = extractText(children).trim();
            // Strip inline style/classDef/class directives — let the theme engine handle colors
            raw = raw.replace(/^\s*(style\s+\S+|classDef\s+|class\s+\S+\s+).*$/gm, '');
            return <MermaidBlock code={raw} MermaidRenderer={MermaidRenderer} />;
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
        // Render @mentions as styled pills in paragraphs and list items
        p({ children }) {
          return <p>{processMentions(children)}</p>;
        },
        li({ children }) {
          return <li>{processMentions(children)}</li>;
        },
        // Wrap tables in a collapsible block with CSV download
        table({ children }) {
          return <TableBlock>{children}</TableBlock>;
        },
      }}
    >
      {processed}
    </ReactMarkdown>
  );
}
