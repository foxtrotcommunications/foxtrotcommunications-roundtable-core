// server/a2a/agentCard.ts — Generate an A2A Agent Card from workspace config
import type { Workspace, Tool, AppConfig } from '../types';

interface AgentCardSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  inputModes: string[];
  outputModes: string[];
}

interface AgentCard {
  name: string;
  description: string;
  version: string;
  provider: { organization: string };
  url: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentCardSkill[];
  securitySchemes: Record<string, unknown>;
  security: Array<Record<string, unknown[]>>;
}

/**
 * Generate an A2A-compliant Agent Card for this workspace.
 *
 * @param workspace  — the workspace row from the database
 * @param enabledTools — array of tool definitions currently enabled
 * @param config — application config (provides platformOrg, workspaceUrl)
 */
function generateAgentCard(
  workspace: Workspace,
  enabledTools: Array<Pick<Tool, 'name' | 'description'>>,
  config: AppConfig
): AgentCard {
  const description =
    workspace.system_prompt
      ? String(workspace.system_prompt).slice(0, 200)
      : 'Roundtable AI workspace';

  return {
    name: workspace.name,
    description,
    version: '1.0.0',
    provider: {
      organization: config.platformOrg || 'Roundtable',
    },
    url: (config.workspaceUrl || '') + '/a2a',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: enabledTools.map((t) => ({
      id: t.name,
      name: t.name,
      description: t.description,
      tags: [],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
    })),
    securitySchemes: {
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
      },
    },
    security: [{ apiKey: [] }],
  };
}

module.exports = { generateAgentCard };
