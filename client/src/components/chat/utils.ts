// Shared utility functions for chat rendering

const GRADIENTS = [
  'linear-gradient(135deg, #6366f1, #8b5cf6)',
  'linear-gradient(135deg, #ec4899, #f43f5e)',
  'linear-gradient(135deg, #f59e0b, #ef4444)',
  'linear-gradient(135deg, #06b6d4, #3b82f6)',
  'linear-gradient(135deg, #8b5cf6, #d946ef)',
  'linear-gradient(135deg, #14b8a6, #06b6d4)',
  'linear-gradient(135deg, #f97316, #facc15)',
  'linear-gradient(135deg, #2563eb, #7c3aed)',
];

export function getUserColor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = ((hash << 5) - hash + username.charCodeAt(i)) | 0;
  }
  return GRADIENTS[Math.abs(hash) % GRADIENTS.length];
}

export function formatTime(timestamp: string): string {
  if (!timestamp) return '';
  let ts = String(timestamp).replace(' ', 'T');
  if (!ts.endsWith('Z') && !ts.includes('+')) ts += 'Z';
  const d = new Date(ts);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const TOOL_ICONS: Record<string, string> = {
  git_clone: '📦', git_commit: '📝', read_file: '📄', write_file: '✏️',
  list_files: '📁', find_file: '🔎', shell_exec: '⚡', web_search: '🔍',
  read_url: '🌐', calculator: '🧮', run_code: '▶️',
  query_bigquery: '🗄️', query_snowflake: '❄️', query_databricks: '🧱',
};
