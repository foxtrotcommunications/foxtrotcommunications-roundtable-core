// Type definitions for chat messages and tool results

import type { ProvenancePayload } from './provenance';

export interface ChatMessage {
  id: number;
  workspace_id: string;
  user_id: number | null;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  username?: string;
  display_name?: string;
  tool_name?: string;
  tool_call_id?: string;
  created_at: string;
  provenance?: ProvenancePayload;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  callId: string;
}

export interface QueryResult {
  sql?: string;
  rows: Record<string, unknown>[];
  columns: string[];
  totalRows: number;
  truncated?: boolean;
  billingProject?: string;
}

export interface FileResult {
  content: string;
  filepath: string;
  lines: number;
  language?: string;
}

export interface ShellResult {
  stdout: string;
  stderr?: string;
  exitCode?: number;
}

export interface SearchResultItem {
  title?: string;
  url?: string;
  snippet?: string;
}

export interface SearchResult {
  summary?: string;
  results: SearchResultItem[];
}

export interface FileListResult {
  directory: string;
  entries: Array<{ name: string; type: 'file' | 'directory'; size?: number }>;
  total: number;
}

export interface FindFileResult {
  matches: string[];
  total: number;
}

export interface WriteResult {
  action: string;
  filepath?: string;
  path?: string;
  lines?: number;
  bytes?: number;
}

export interface GitCommitResult {
  commitHash: string;
  branch: string;
  filesChanged: number;
  pushed?: boolean;
  prUrl?: string;
  pushError?: string;
  prError?: string;
}

export interface CalculatorResult {
  result: string | number;
}

export interface ErrorResult {
  error: string;
}

export interface ChartResult {
  chartType: 'bar' | 'line' | 'pie' | 'doughnut' | 'scatter' | 'area';
  title: string;
  labels: string[];
  datasets: Array<{
    label: string;
    data: number[];
    backgroundColor?: string | string[];
    borderColor?: string | string[];
  }>;
  xAxisLabel?: string | null;
  yAxisLabel?: string | null;
  stacked?: boolean;
}

export type ToolResultData =
  | QueryResult
  | ChartResult
  | FileResult
  | ShellResult
  | SearchResult
  | FileListResult
  | FindFileResult
  | WriteResult
  | GitCommitResult
  | CalculatorResult
  | ErrorResult;

export interface ToolResult {
  callId: string;
  result: ToolResultData;
}
