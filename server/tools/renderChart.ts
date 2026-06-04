// @ts-nocheck
// server/tools/renderChart.js — Chart visualization tool (inline in message)
import type { Tool } from '../types';
// @ts-ignore


const tool: Tool = {
  name: 'render_chart',
  description: 'Render a chart visualization inline in your response. After calling this tool, you MUST include the returned chart block in your response text exactly as provided — it will render as an interactive chart for the user.',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['bar', 'line', 'pie', 'doughnut', 'scatter', 'area'],
        description: 'Chart type. Use bar for comparisons, line for trends over time, pie/doughnut for proportions, scatter for correlations.',
      },
      title: {
        type: 'string',
        description: 'Chart title displayed above the visualization',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'X-axis labels (categories). For pie/doughnut, these are slice labels.',
      },
      datasets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Dataset name (legend label)' },
            data: { type: 'array', items: { type: 'number' }, description: 'Data values' },
            backgroundColor: { type: 'string', description: 'Fill color (CSS color string)' },
            borderColor: { type: 'string', description: 'Border color (CSS color string)' },
          },
          required: ['label', 'data'],
        },
        description: 'Array of dataset objects with label, data array, and optional colors.',
      },
      xAxisLabel: {
        type: 'string',
        description: 'X-axis label (optional)',
      },
      yAxisLabel: {
        type: 'string',
        description: 'Y-axis label (optional)',
      },
      stacked: {
        type: 'boolean',
        description: 'Whether to stack bars/areas (default: false)',
        default: false,
      },
    },
    required: ['type', 'title', 'labels', 'datasets'],
  },
  async execute(args: any, _workspaceConfig: any = {}, _context?: any) {
    const { type, title, labels, datasets } = args;

    if (!Array.isArray(labels) || labels.length === 0) {
      return { error: 'labels must be a non-empty array' };
    }
    if (!Array.isArray(datasets) || datasets.length === 0) {
      return { error: 'datasets must be a non-empty array' };
    }
    for (const ds of datasets) {
      if (!ds.data || !Array.isArray(ds.data)) {
        return { error: `Dataset "${ds.label || 'unnamed'}" must have a "data" array` };
      }
    }

    // Build the chart config
    const chartConfig = {
      chartType: type,
      title,
      labels,
      datasets,
      xAxisLabel: args.xAxisLabel || null,
      yAxisLabel: args.yAxisLabel || null,
      stacked: args.stacked || false,
    };

    // Return the chart block — the AI MUST include this in its response
    const chartBlock = '```chart\n' + JSON.stringify(chartConfig) + '\n```';

    return {
      success: true,
      message: `Chart rendered successfully. IMPORTANT: Include the following chart block in your response to display it to the user:\n\n${chartBlock}`,
      chartBlock,
    };
  },
};

export default tool;
