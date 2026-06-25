import React, { memo, useCallback } from 'react';
import RoseChart from './RoseChart';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Filler,
  Tooltip,
  Legend,
  Title,
} from 'chart.js';
import { Bar, Line, Pie, Doughnut, Scatter, Chart as ChartComponentRaw } from 'react-chartjs-2';

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Filler,
  Tooltip,
  Legend,
  Title,
);

// Dynamically register optional plugins (non-fatal if unavailable)
(async () => {
  try {
    const annotation = await import('chartjs-plugin-annotation');
    ChartJS.register(annotation.default);
  } catch { /* optional plugin */ }
  try {
    const treemap = await import('chartjs-chart-treemap');
    ChartJS.register(treemap.TreemapController, treemap.TreemapElement);
  } catch { /* optional plugin */ }
})();

export interface ChartConfig {
  chartType: 'bar' | 'line' | 'pie' | 'doughnut' | 'scatter' | 'area'
    | 'waterfall' | 'treemap' | 'fan' | 'scenario' | 'overlap'
    | 'rose' | 'polar' | 'radar';
  title: string;
  labels: string[];
  datasets: Array<{
    label: string;
    data: any[];
    backgroundColor?: string | string[];
    borderColor?: string | string[];
  }>;
  xAxisLabel?: string | null;
  yAxisLabel?: string | null;
  stacked?: boolean;
  horizontal?: boolean;
  numberFormat?: { prefix?: string; suffix?: string; compact?: boolean };
  currency?: string;
  annotations?: Array<{ type: string; value: number; label?: string; color?: string; axis?: string }>;
  colors?: string[];
  totals?: boolean[];
}

const PALETTE = [
  '#6B7F4E', // olive drab
  '#8B7D3C', // dark goldenrod / muted yellow-olive
  '#A68B4B', // warm ochre
  '#9B6B47', // burnt sienna / muted red-brown
  '#7D5A50', // clay
  '#5C7A6B', // muted sage teal
  '#8A7E6B', // warm taupe
  '#6E7E5A', // moss green
  '#B89B6A', // muted gold
  '#8C6356', // dusty terracotta
  '#5B6E5D', // deep sage
  '#A08C72', // sandstone
];

const WATERFALL_COLORS = {
  increase: '#6B7F4E',
  decrease: '#9B6B47',
  total: '#5C7A6B',
};

const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };

/* ── Number formatting ──────────────────────────────────────────── */

function formatNumber(
  value: number,
  fmt?: { prefix?: string; suffix?: string; compact?: boolean },
): string {
  if (!fmt) return String(value);
  let str: string;
  if (fmt.compact) {
    if (Math.abs(value) >= 1_000_000_000) str = (value / 1_000_000_000).toFixed(1) + 'B';
    else if (Math.abs(value) >= 1_000_000) str = (value / 1_000_000).toFixed(1) + 'M';
    else if (Math.abs(value) >= 1_000) str = (value / 1_000).toFixed(1) + 'K';
    else str = value.toFixed(0);
  } else {
    str = value.toLocaleString();
  }
  return (fmt.prefix || '') + str + (fmt.suffix || '');
}

function resolveNumberFormat(config: ChartConfig) {
  if (config.numberFormat) return config.numberFormat;
  if (config.currency) {
    const symbol = CURRENCY_SYMBOLS[config.currency.toUpperCase()] || (config.currency + ' ');
    return { prefix: symbol, compact: true };
  }
  return undefined;
}

/* ── CSV builder ────────────────────────────────────────────────── */

function buildCsv(config: ChartConfig): string {
  const isScatter = config.chartType === 'scatter';
  const rows: string[][] = [];

  if (isScatter) {
    const headers = ['Label'];
    config.datasets.forEach(ds => {
      headers.push(`${ds.label} X`, `${ds.label} Y`);
    });
    rows.push(headers);
    const maxLen = Math.max(...config.datasets.map(ds => ds.data.length));
    for (let i = 0; i < maxLen; i++) {
      const row: string[] = [config.labels[i] || `Point ${i + 1}`];
      config.datasets.forEach(ds => {
        const pt = ds.data[i];
        if (pt && typeof pt === 'object' && 'x' in pt) {
          row.push(String(pt.x), String(pt.y));
        } else if (typeof pt === 'number') {
          row.push(String(parseFloat(config.labels[i]) || i), String(pt));
        } else {
          row.push('', '');
        }
      });
      rows.push(row);
    }
  } else {
    const headers = [config.xAxisLabel || 'Label'];
    config.datasets.forEach(ds => headers.push(ds.label));
    rows.push(headers);
    for (let i = 0; i < config.labels.length; i++) {
      const row: string[] = [config.labels[i]];
      config.datasets.forEach(ds => {
        const val = ds.data[i];
        row.push(typeof val === 'number' ? String(val) : '');
      });
      rows.push(row);
    }
  }

  return rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
}

/* ── Waterfall builder ──────────────────────────────────────────── */

function buildWaterfallData(config: ChartConfig) {
  const raw = config.datasets[0]?.data as number[] ?? [];
  const palette = config.colors?.length === 3
    ? { increase: config.colors[0], decrease: config.colors[1], total: config.colors[2] }
    : WATERFALL_COLORS;

  let running = 0;
  const floatingBars: [number, number][] = [];
  const barColors: string[] = [];

  raw.forEach((val, i) => {
    const isTotal = config.totals?.[i] === true;
    if (isTotal) {
      floatingBars.push([0, running]);
      barColors.push(palette.total);
    } else {
      const prev = running;
      running += val;
      floatingBars.push([Math.min(prev, running), Math.max(prev, running)]);
      barColors.push(val >= 0 ? palette.increase : palette.decrease);
    }
  });

  return {
    labels: config.labels,
    datasets: [{
      label: config.datasets[0]?.label || 'Value',
      data: floatingBars,
      backgroundColor: barColors,
      borderColor: barColors,
      borderWidth: 1,
      borderSkipped: false,
    }],
  };
}

/* ── Fan builder ────────────────────────────────────────────────── */

function buildFanDatasets(config: ChartConfig) {
  const palette = config.colors?.length ? config.colors : PALETTE;
  const bandOpacities = [0.25, 0.12, 0.06];
  return config.datasets.map((ds, i) => {
    if (i === 0) {
      return {
        ...ds,
        backgroundColor: palette[0],
        borderColor: palette[0],
        borderWidth: 2,
        fill: false,
        tension: 0.3,
        pointRadius: 2,
        pointHoverRadius: 5,
      };
    }
    const bandIdx = Math.floor((i - 1) / 2);
    const opacity = bandOpacities[Math.min(bandIdx, bandOpacities.length - 1)];
    const isUpper = i % 2 === 1;
    const fillTarget = isUpper ? (i === 1 ? 0 : i - 2) : (i === 2 ? 0 : i - 2);
    const fillColor = `rgba(99, 102, 241, ${opacity})`;

    return {
      ...ds,
      backgroundColor: fillColor,
      borderColor: 'transparent',
      borderWidth: 0,
      fill: isUpper
        ? { target: fillTarget, above: fillColor }
        : { target: fillTarget, below: fillColor },
      tension: 0.3,
      pointRadius: 0,
    };
  });
}

/* ── Treemap builder ────────────────────────────────────────────── */

function buildTreemapData(config: ChartConfig) {
  const palette = config.colors?.length ? config.colors : PALETTE;
  const treeData = config.datasets[0]?.data ?? [];
  const hasGroups = treeData.some((d: any) => d.group);
  return {
    datasets: [{
      tree: treeData,
      key: 'value',
      groups: hasGroups ? ['group', 'label'] : ['label'],
      backgroundColor: (ctx: any) => palette[ctx.dataIndex % palette.length],
      borderColor: 'rgba(0,0,0,0.1)',
      borderWidth: 2,
      spacing: 1,
      labels: {
        display: true,
        formatter: (ctx: any) => ctx.raw?.g || ctx.raw?._data?.label || '',
        color: '#fff',
        font: { size: 12, weight: 'bold' as const },
      },
    }],
  };
}

/* ── Standard defaults ──────────────────────────────────────────── */

function applyDefaults(config: ChartConfig) {
  const isRadial = config.chartType === 'pie' || config.chartType === 'doughnut';
  const isScatter = config.chartType === 'scatter';
  const isScenario = config.chartType === 'scenario';
  const palette = config.colors?.length ? config.colors : PALETTE;

  return config.datasets.map((ds, i) => {
    let data = ds.data;
    if (isScatter && data.length > 0 && typeof data[0] === 'number') {
      data = (data as number[]).map((y, j) => ({
        x: parseFloat(config.labels[j]) || j,
        y,
      }));
    }

    if (isRadial) {
      return {
        ...ds,
        data,
        backgroundColor: (ds.data as number[]).map((_, j) => palette[j % palette.length]),
        borderColor: '#ffffff',
        borderWidth: 2,
      };
    }
    return {
      ...ds,
      data,
      backgroundColor: ds.backgroundColor ?? palette[i % palette.length],
      borderColor: ds.borderColor ?? palette[i % palette.length],
      borderWidth: isScenario ? 3 : 2,
      ...(isScatter ? { pointRadius: 6, pointHoverRadius: 8 } : {}),
      ...(isScenario ? { pointRadius: 4, pointHoverRadius: 7 } : {}),
      ...(config.chartType === 'area' ? { fill: true } : {}),
      ...(['line', 'area', 'scenario'].includes(config.chartType) ? { tension: 0.3 } : {}),
    };
  });
}

/* ── Main component ─────────────────────────────────────────────── */

function ChartRendererInner({ config }: { config: ChartConfig; onToggleTable?: () => void }) {
  const numFmt = resolveNumberFormat(config);
  const type = config.chartType;
  const isRose = type === 'rose';
  const isWaterfall = type === 'waterfall';
  const isTreemap = type === 'treemap';
  const isFan = type === 'fan';
  const isOverlap = type === 'overlap';
  const useHorizontal = isOverlap || (config.horizontal && type === 'bar');
  const useStacked = isOverlap || config.stacked || false;
  const isRadial = type === 'pie' || type === 'doughnut';

  // Build data
  let data: any;
  if (isWaterfall) {
    data = buildWaterfallData(config);
  } else if (isTreemap) {
    data = buildTreemapData(config);
  } else if (isFan) {
    data = { labels: config.labels, datasets: buildFanDatasets(config) };
  } else {
    const datasets = applyDefaults(config);
    data = {
      labels: type === 'scatter' ? [] : config.labels,
      datasets,
    };
  }

  // Scatter point labels
  const scatterPointLabels = config.labels;

  // Tick formatter
  const tickCallback = numFmt
    ? (_value: any) => formatNumber(Number(_value), numFmt)
    : undefined;

  // Tooltip callbacks
  const tooltipCallbacks: Record<string, any> = {};
  if (type === 'scatter' && scatterPointLabels.length > 0) {
    tooltipCallbacks.label = (ctx: any) => {
      const pointName = scatterPointLabels[ctx.dataIndex] || `Point ${ctx.dataIndex}`;
      const x = typeof ctx.parsed.x === 'number' ? ctx.parsed.x.toFixed(2) : ctx.parsed.x;
      const y = typeof ctx.parsed.y === 'number' ? ctx.parsed.y.toFixed(2) : ctx.parsed.y;
      return `${pointName}: (${x}, ${y})`;
    };
  } else if (isWaterfall && numFmt) {
    tooltipCallbacks.label = (item: any) => {
      const dsLabel = item.dataset?.label || '';
      const raw = item.raw;
      const val = Array.isArray(raw) ? raw[1] - raw[0] : item.parsed?.y ?? 0;
      return `${dsLabel}: ${formatNumber(val, numFmt)}`;
    };
  } else if (numFmt) {
    tooltipCallbacks.label = (item: any) => {
      const dsLabel = item.dataset?.label || '';
      const val = item.parsed?.y ?? item.parsed ?? item.raw;
      return `${dsLabel}: ${formatNumber(typeof val === 'number' ? val : Number(val), numFmt)}`;
    };
  }

  // Annotation config
  const annotationConfig = config.annotations?.length
    ? {
        annotation: {
          annotations: config.annotations.reduce((acc: Record<string, any>, a, i) => {
            acc[`anno_${i}`] = {
              type: 'line',
              scaleID: a.axis === 'x' ? 'x' : 'y',
              value: a.value,
              borderColor: a.color || '#ef4444',
              borderWidth: 2,
              borderDash: [6, 3],
              label: {
                display: !!a.label,
                content: a.label,
                position: 'end',
                backgroundColor: a.color || '#ef4444',
                color: '#fff',
                font: { size: 11 },
                padding: 4,
              },
            };
            return acc;
          }, {}),
        },
      }
    : {};

  const cartesianOptions: any = {
    responsive: true,
    maintainAspectRatio: false,
    ...(useHorizontal ? { indexAxis: 'y' } : {}),
    plugins: {
      title: { display: !!config.title, text: config.title, color: '#1e293b' },
      legend: {
        display: type !== 'scatter',
        labels: { color: '#374151' },
      },
      tooltip: Object.keys(tooltipCallbacks).length
        ? { callbacks: tooltipCallbacks }
        : undefined,
      ...annotationConfig,
    },
    scales: {
      x: {
        title: { display: !!config.xAxisLabel, text: config.xAxisLabel ?? '' },
        stacked: useStacked,
        ticks: {
          color: '#64748b',
          ...(useHorizontal && tickCallback ? { callback: tickCallback } : {}),
        },
        grid: { color: '#e5e7eb' },
      },
      y: {
        title: { display: !!config.yAxisLabel, text: config.yAxisLabel ?? '' },
        stacked: useStacked,
        ticks: {
          color: '#64748b',
          ...(!useHorizontal && tickCallback ? { callback: tickCallback } : {}),
        },
        grid: { color: '#e5e7eb' },
      },
    },
  };

  const radialOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      title: { display: !!config.title, text: config.title, color: '#1e293b' },
      legend: { labels: { color: '#374151' } },
    },
  };

  const handleDownloadCsv = useCallback(() => {
    const csv = buildCsv(config);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(config.title || 'chart').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [config]);

  // Select component
  const chartOptions: any = isRadial ? radialOptions : cartesianOptions;
  const palette = config.colors?.length ? config.colors : PALETTE;
  const ChartComponent: any = isRadial
    ? (type === 'pie' ? Pie : Doughnut)
    : isTreemap
      ? null
      : isRose
        ? null
        : (isWaterfall || type === 'bar' || isOverlap)
          ? Bar
          : (type === 'line' || type === 'area' || isFan || type === 'scenario')
            ? Line
            : type === 'scatter'
              ? Scatter
              : Bar;

  return (
    <div className={`msg-chart-wrap${isRose ? ' msg-chart-wrap--rose' : ''}`}>
      {isRose ? (
        <RoseChart
          labels={config.labels || []}
          thetaValues={(config.datasets[0]?.data as number[]) || []}
          radiusValues={(config.datasets[1]?.data as number[]) || []}
          palette={palette}
          thetaLabel={config.datasets[0]?.label || 'Share'}
          radiusLabel={config.datasets[1]?.label || 'Change'}
        />
      ) : isTreemap ? (
        <div style={{ position: 'relative', width: '100%', height: '400px' }}>
          <ChartComponentRaw
            type="treemap"
            data={data}
            options={{
              responsive: true,
              maintainAspectRatio: false,
              plugins: {
                title: { display: !!config.title, text: config.title, color: '#1e293b' },
                legend: { display: false },
              },
            }}
          />
        </div>
      ) : ChartComponent ? (
        <div style={{ position: 'relative', width: '100%', height: '400px' }}>
          <ChartComponent data={data} options={chartOptions} />
        </div>
      ) : null}
      <button
        onClick={handleDownloadCsv}
        className="chart-download-csv"
        title="Download chart data as CSV"
      >
        ↓ Download CSV
      </button>
    </div>
  );
}

// Error boundary
class ChartErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: string }
> {
  state = { hasError: false, error: '' };
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }
  componentDidCatch(error: Error) {
    console.error('ChartRenderer error:', error);
  }
  render() {
    if (this.state.hasError) {
      return <p style={{ color: '#ef4444', fontSize: '13px', padding: '16px' }}>Chart error: {this.state.error}</p>;
    }
    return this.props.children;
  }
}

function ChartRendererWithBoundary({ config, onToggleTable }: { config: ChartConfig; onToggleTable?: () => void }) {
  return (
    <ChartErrorBoundary>
      <ChartRendererInner config={config} onToggleTable={onToggleTable} />
    </ChartErrorBoundary>
  );
}

// Memoize to prevent re-renders during streaming text updates
const ChartRenderer = memo(ChartRendererWithBoundary, (prev, next) => {
  return JSON.stringify(prev.config) === JSON.stringify(next.config);
});

export default ChartRenderer;
