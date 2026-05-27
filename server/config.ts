// server/config.ts — Environment configuration loader
import type { AppConfig } from './types';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const config: AppConfig = {
  port: parseInt(process.env.PORT as string, 10) || 3000,
  sessionSecret: process.env.SESSION_SECRET || 'roundtable-dev-secret-change-me',

  // Database (PostgreSQL required)
  databaseUrl: process.env.DATABASE_URL || '',

  // Workspace identity (provisioner injects WS_ID; WORKSPACE_ID is legacy)
  workspaceId: process.env.WS_ID || process.env.WORKSPACE_ID || 'default',
  workspaceName: process.env.WS_NAME || process.env.WORKSPACE_NAME || process.env.WS_ID || process.env.WORKSPACE_ID || 'Roundtable',
  workspaceUrl: process.env.WORKSPACE_URL || '',

  // Platform branding (appears in system prompt and describe_workspace)
  platformOrg: process.env.PLATFORM_ORG || '',

  embedMode: process.env.EMBED_MODE === 'true',
  demoMode: process.env.DEMO_MODE === 'true',

  // Server-level AI keys (fallback if user hasn't configured their own)
  ai: {
    openai: process.env.OPENAI_API_KEY || '',
    anthropic: process.env.ANTHROPIC_API_KEY || '',
    google: process.env.GOOGLE_AI_API_KEY || '',
  },

  // Vertex AI (uses ADC — no API key needed)
  vertexai: {
    project: process.env.GCP_PROJECT || '',
    location: process.env.GCP_LOCATION || 'us-central1',
  },

  // Ollama / OpenAI-compatible endpoint (default, overridable per-workspace)
  ollama: {
    host: process.env.OLLAMA_HOST || 'http://localhost:11434',
  },

  // Google Custom Search (for web_search tool)
  googleSearch: {
    apiKey: process.env.GOOGLE_SEARCH_API_KEY || '',
    engineId: process.env.GOOGLE_SEARCH_ENGINE_ID || '',
  },

  // Data warehouse connections
  snowflake: {
    account: process.env.SNOWFLAKE_ACCOUNT || '',
    username: process.env.SNOWFLAKE_USERNAME || '',
    warehouse: process.env.SNOWFLAKE_WAREHOUSE || '',
    database: process.env.SNOWFLAKE_DATABASE || '',
    schema: process.env.SNOWFLAKE_SCHEMA || '',
  },

  databricks: {
    host: process.env.DATABRICKS_HOST || '',
    httpPath: process.env.DATABRICKS_HTTP_PATH || '',
    catalog: process.env.DATABRICKS_CATALOG || '',
    schema: process.env.DATABRICKS_SCHEMA || '',
  },
};

module.exports = config;
