// @ts-nocheck
// server/tools/renderChart.js — Chart visualization tool (inline in message)
import type { Tool } from '../types';
// @ts-ignore


const tool: Tool = {
  name: 'render_chart',
  description: 'Render an interactive chart visualization inline in your response. The chart is automatically displayed to the user — do NOT include any raw JSON, chart blocks, or mermaid diagrams in your text. After the chart renders, simply provide a blockquote italic caption with the key takeaway and continue your analysis. Supports: bar, line, pie, doughnut, scatter, area, waterfall (value buildups), treemap (hierarchical proportions), fan (projections with confidence bands), scenario (side-by-side comparisons), overlap (exposure analysis), polar (radial proportions with magnitude), radar (multi-dimensional comparisons), and rose (coxcomb — each petal has variable angular width AND variable radius, encoding TWO variables simultaneously).',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['bar', 'line', 'pie', 'doughnut', 'scatter', 'area', 'waterfall', 'treemap', 'fan', 'scenario', 'overlap', 'polar', 'radar', 'rose'],
        description: 'Chart type. Use bar for comparisons, line for trends over time, pie/doughnut for proportions, scatter for correlations, waterfall for value buildups/breakdowns, treemap for hierarchical proportions, fan for projections with confidence bands, scenario for side-by-side comparisons, overlap for exposure/overlap analysis, polar for radial proportions (like pie but with magnitude), radar for multi-dimensional comparisons, rose for coxcomb charts encoding TWO variables (datasets[0] = theta/angular widths as % shares, datasets[1] = radius/petal lengths as values — perfect for "slice by X, radius by Y" requests). IMPORTANT: For scatter charts, each data point must be an object {x: number, y: number} — do NOT use flat number arrays.',
      },
      title: {
        type: 'string',
        description: 'Chart title displayed above the visualization',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'X-axis labels (categories). For pie/doughnut, these are slice labels. For waterfall/treemap, labels can be omitted and derived from data.',
      },
      datasets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Dataset name (legend label)' },
            data: { type: 'array', items: { oneOf: [{ type: 'number' }, { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] }, { type: 'object', properties: { label: { type: 'string' }, value: { type: 'number' }, group: { type: 'string' } }, required: ['label', 'value'] }] }, description: 'Data values. For scatter charts, use [{x, y}, ...]. For treemap, use [{label, value, group?}, ...]. For all other charts, use [number, ...].' },
            backgroundColor: { type: 'string', description: 'Fill color (CSS color string)' },
            borderColor: { type: 'string', description: 'Border color (CSS color string)' },
          },
          required: ['label', 'data'],
        },
        description: 'Array of dataset objects with label, data array, and optional colors. For fan charts, the first dataset is the central projection and subsequent datasets are upper/lower confidence bounds. For scenario charts, each dataset is one scenario line. For overlap charts, datasets stack horizontally.',
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
      numberFormat: {
        type: 'object',
        description: 'Number formatting options applied to y-axis ticks and tooltips. Example: {prefix: "$", compact: true} for $1.2M style.',
      },
      annotations: {
        type: 'array',
        description: 'Array of reference lines or labels to overlay on the chart. Each object: {type: "line"|"label", value: number, label: string, color?: string, axis?: "x"|"y"}.',
      },
      horizontal: {
        type: 'boolean',
        description: 'If true, render bar charts horizontally (indexAxis: "y"). Default: false.',
        default: false,
      },
      colors: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of CSS color strings to override the default palette. For waterfall charts, provide 3 colors: [increase, decrease, total].',
      },
      currency: {
        type: 'string',
        description: 'Currency shorthand (e.g. "USD", "EUR"). If set, auto-applies the appropriate prefix (e.g. "$") and compact formatting.',
      },
      totals: {
        type: 'array',
        items: { type: 'boolean' },
        description: 'For waterfall charts only. Array of booleans (same length as labels) — true means that bar shows the running total, false means it shows the delta.',
      },
    },
    required: ['type', 'title', 'labels', 'datasets'],
  },
  async execute(args: any, _workspaceConfig: any = {}, _context?: any) {
    const { type, title, labels, datasets } = args;

    // For waterfall and treemap, labels can be derived from data — relax the requirement
    const labelsRequired = !['waterfall', 'treemap'].includes(type);

    if (labelsRequired && (!Array.isArray(labels) || labels.length === 0)) {
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
      numberFormat: args.numberFormat || null,
      annotations: args.annotations || null,
      horizontal: args.horizontal || false,
      colors: args.colors || null,
      currency: args.currency || null,
      totals: args.totals || null,
    };

    // Return the chart block — auto-injected into the stream by chatHandler
    const chartBlock = '```chart\n' + JSON.stringify(chartConfig) + '\n```';

    return {
      success: true,
      message: `Chart "${chartConfig.title}" rendered successfully and is now visible to the user. Do NOT include any raw chart JSON, chart blocks, or mermaid diagrams in your response — the chart is already displayed. Simply continue with your analysis or commentary about what the chart shows.`,
      chartBlock,
    };
  },
};

export default tool;
