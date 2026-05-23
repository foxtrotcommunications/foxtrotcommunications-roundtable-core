// server/tools/renderChart.js — Chart visualization tool (client-rendered)
module.exports = {
  name: 'render_chart',
  description: 'Render a chart visualization. Use after running a data query to create bar, line, pie, scatter, doughnut, or area charts. Pass the query results as labels and datasets.',
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
        description: 'X-axis labels (categories). For pie/doughnut, these are slice labels.',
      },
      datasets: {
        type: 'array',
        description: 'Array of dataset objects. Each: { label: string, data: number[], backgroundColor?: string, borderColor?: string }',
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
  async execute(args) {
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

    // Pass-through — client renders the chart from this spec
    return {
      chartType: type,
      title,
      labels,
      datasets,
      xAxisLabel: args.xAxisLabel || null,
      yAxisLabel: args.yAxisLabel || null,
      stacked: args.stacked || false,
    };
  },
};
