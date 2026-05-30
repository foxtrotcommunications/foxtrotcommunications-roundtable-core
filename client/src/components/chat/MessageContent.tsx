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
  /** Known mention targets — display names and usernames that should be highlighted */
  knownMentions?: string[];
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

/**
 * Replace @mentions in a text string with styled span elements.
 * Matches against actual known usernames/display names rather than regex guessing.
 */
function renderMentions(text: string, knownMentions: string[]): ReactNode[] {
  if (knownMentions.length === 0) return [text];

  // Build a regex that matches @<known_name> for each known mention target.
  // Sort by length descending so "Brady Bastian" matches before "Brady".
  const sorted = [...knownMentions].sort((a, b) => b.length - a.length);
  const escaped = sorted.map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(@(?:${escaped.join('|')}))(?=\\b|[^\\w]|$)`, 'gi');

  const result: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    // Add any text before this match
    if (match.index > lastIndex) {
      result.push(text.slice(lastIndex, match.index));
    }
    const mentionText = match[1];
    const isAi = mentionText.toLowerCase() === '@ai';
    result.push(
      <span key={match.index} className={`mention${isAi ? ' mention-ai' : ''}`}>
        {mentionText}
      </span>
    );
    lastIndex = match.index + match[0].length;
  }

  // Add remaining text after last match
  if (lastIndex < text.length) {
    result.push(text.slice(lastIndex));
  }

  return result.length > 0 ? result : [text];
}

/** Recursively process React children to add mention styling */
function processMentions(children: ReactNode, knownMentions: string[]): ReactNode {
  if (typeof children === 'string') return renderMentions(children, knownMentions);
  if (Array.isArray(children)) return children.map((c, i) => <span key={i}>{processMentions(c, knownMentions)}</span>);
  return children;
}

export default function MessageContent({ content, streaming, knownMentions = [] }: Props) {
  const processed = useMemo(() => content, [content]);

  // Always include 'ai' as a known mention
  const mentions = useMemo(() => {
    const set = new Set(knownMentions.map(m => m.toLowerCase()));
    set.add('ai');
    // Deduplicate and return
    return Array.from(new Set([...knownMentions, 'ai']));
  }, [knownMentions]);

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
          return <p>{processMentions(children, mentions)}</p>;
        },
        li({ children }) {
          return <li>{processMentions(children, mentions)}</li>;
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
