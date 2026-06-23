// @ts-nocheck
import { useRef, memo } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Filler,
  Tooltip,
  Legend,
} from 'chart.js';
import { Bar, Line, Pie, Doughnut, Scatter, Chart as ChartComponentRaw } from 'react-chartjs-2';
import annotationPlugin from 'chartjs-plugin-annotation';
import { TreemapController, TreemapElement } from 'chartjs-chart-treemap';
import type { ChartResult } from '../../types/message';

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Filler,
  Tooltip,
  Legend,
  annotationPlugin,
  TreemapController,
  TreemapElement
);

const EXEC_PALETTE = [
  'rgba(99, 102, 241, 0.8)',   // indigo
  'rgba(168, 85, 247, 0.8)',   // purple
  'rgba(59, 130, 246, 0.8)',   // blue
  'rgba(34, 211, 238, 0.8)',   // cyan
  'rgba(52, 211, 153, 0.8)',   // emerald
  'rgba(251, 191, 36, 0.8)',   // amber
  'rgba(251, 113, 133, 0.8)',  // rose
  'rgba(244, 114, 182, 0.8)',  // pink
];

const BORDER_PALETTE = EXEC_PALETTE.map(c => c.replace('0.8)', '1)'));

const WATERFALL_COLORS = {
  increase: 'rgba(52, 211, 153, 0.8)',  // emerald
  decrease: 'rgba(251, 113, 133, 0.8)', // rose
  total: 'rgba(99, 102, 241, 0.8)',      // indigo
};

/* ── Number formatting helper ─────────────────────────────────────── */

function formatNumber(
  value: number,
  fmt?: { prefix?: string; suffix?: string; compact?: boolean },
): string {
  if (!fmt) return String(value);
  let str = '';
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

/* ── Currency → numberFormat shorthand ────────────────────────────── */

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
};

function resolveNumberFormat(config: ChartResult) {
  if (config.numberFormat) return config.numberFormat;
  if (config.currency) {
    const symbol = CURRENCY_SYMBOLS[config.currency.toUpperCase()] || (config.currency + ' ');
    return { prefix: symbol, compact: true };
  }
  return undefined;
}

/* ── Component ────────────────────────────────────────────────────── */

interface Props {
  config: ChartResult;
  onToggleTable?: () => void;
}

function ChartRenderer({ config, onToggleTable }: Props) {
  const chartRef = useRef<ChartJS | null>(null);
  const palette = config.colors?.length ? config.colors : EXEC_PALETTE;
  const borderPalette = palette.map(c => c.replace(/[\d.]+\)$/, '1)'));
  const numFmt = resolveNumberFormat(config);

  /* ── Annotation config ─────────────────────────────────────────── */

  const annotationConfig = config.annotations?.length
    ? {
        annotation: {
          annotations: config.annotations.reduce((acc: Record<string, any>, a, i) => {
            acc[`anno_${i}`] = {
              type: 'line' as const,
              scaleID: a.axis === 'x' ? 'x' : 'y',
              value: a.value,
              borderColor: a.color || '#ef4444',
              borderWidth: 2,
              borderDash: [6, 3],
              label: {
                display: !!a.label,
                content: a.label,
                position: 'end' as const,
                backgroundColor: a.color || '#ef4444',
                color: '#fff',
                font: { size: 11, family: 'Inter, sans-serif' },
                padding: 4,
              },
            };
            return acc;
          }, {} as Record<string, any>),
        },
      }
    : {};

  /* ── Waterfall data builder ────────────────────────────────────── */

  const buildWaterfallData = () => {
    const raw = config.datasets[0]?.data as number[] ?? [];
    const wColors = config.colors?.length === 3
      ? { increase: config.colors[0], decrease: config.colors[1], total: config.colors[2] }
      : WATERFALL_COLORS;

    let running = 0;
    const floatingBars: [number, number][] = [];
    const barColors: string[] = [];
    const barBorders: string[] = [];

    raw.forEach((val, i) => {
      const isTotal = config.totals?.[i] === true;
      if (isTotal) {
        // Total bar: from 0 to the running total
        floatingBars.push([0, running]);
        barColors.push(wColors.total);
        barBorders.push(wColors.total.replace(/[\d.]+\)$/, '1)'));
      } else {
        const prev = running;
        running += val;
        // Floating bar from previous running total to new running total
        floatingBars.push([Math.min(prev, running), Math.max(prev, running)]);
        barColors.push(val >= 0 ? wColors.increase : wColors.decrease);
        barBorders.push(
          (val >= 0 ? wColors.increase : wColors.decrease).replace(/[\d.]+\)$/, '1)')
        );
      }
    });

    return {
      labels: config.labels,
      datasets: [
        {
          label: config.datasets[0]?.label || 'Value',
          data: floatingBars,
          backgroundColor: barColors,
          borderColor: barBorders,
          borderWidth: 2,
          borderSkipped: false,
        },
      ],
    };
  };

  /* ── Fan data builder ──────────────────────────────────────────── */

  const buildFanDatasets = () => {
    const bandOpacities = [0.25, 0.12, 0.06];
    return config.datasets.map((ds, i) => {
      if (i === 0) {
        // Central projection line
        return {
          ...ds,
          backgroundColor: palette[0],
          borderColor: borderPalette[0],
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
      const fillTarget = isUpper
        ? (i === 1 ? 0 : i - 2) // upper: fill toward center or prev upper
        : (i === 2 ? 0 : i - 2); // lower: fill toward center or prev lower
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
        pointHoverRadius: 0,
      };
    });
  };

  /* ── Treemap data builder ──────────────────────────────────────── */

  const buildTreemapData = () => {
    const treeData = config.datasets[0]?.data as any[] ?? [];
    const hasGroups = treeData.some((d: any) => d.group);
    return {
      datasets: [
        {
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
            font: { size: 12, family: 'Inter, sans-serif', weight: 'bold' as const },
          },
          captions: {
            display: true,
            color: '#a1a1aa',
            font: { size: 11, family: 'Inter, sans-serif' },
          },
        },
      ],
    };
  };

  /* ── Shared dataset builder (bar/line/area/pie/doughnut/scatter/scenario/overlap) ─ */

  const buildStandardDatasets = () => {
    const isOverlap = config.chartType === 'overlap';
    const isScenario = config.chartType === 'scenario';

    return config.datasets.map((ds, i) => ({
      ...ds,
      backgroundColor: ds.backgroundColor || (
        ['pie', 'doughnut'].includes(config.chartType)
          ? palette.slice(0, ds.data.length)
          : palette[i % palette.length]
      ),
      borderColor: ds.borderColor || (
        ['pie', 'doughnut'].includes(config.chartType)
          ? borderPalette.slice(0, ds.data.length)
          : borderPalette[i % borderPalette.length]
      ),
      borderWidth: isScenario ? 3 : 2,
      fill: config.chartType === 'area',
      tension: ['line', 'area', 'scenario'].includes(config.chartType) ? 0.3 : undefined,
      pointRadius: config.chartType === 'scatter' ? 5 : (isScenario ? 4 : 3),
      pointHoverRadius: isScenario ? 7 : 6,
    }));
  };

  /* ── Determine data & datasets ─────────────────────────────────── */

  const isWaterfall = config.chartType === 'waterfall';
  const isTreemap = config.chartType === 'treemap';
  const isFan = config.chartType === 'fan';
  const isOverlap = config.chartType === 'overlap';

  let data: any;
  if (isWaterfall) {
    data = buildWaterfallData();
  } else if (isTreemap) {
    data = buildTreemapData();
  } else if (isFan) {
    data = { labels: config.labels, datasets: buildFanDatasets() };
  } else {
    data = { labels: config.labels, datasets: buildStandardDatasets() };
  }

  /* ── Horizontal bar support ────────────────────────────────────── */

  const useHorizontal =
    isOverlap || (config.horizontal && ['bar', 'overlap'].includes(config.chartType));

  /* ── Stacked support ───────────────────────────────────────────── */

  const useStacked = isOverlap || config.stacked || false;

  /* ── Tooltip callbacks ─────────────────────────────────────────── */

  const tooltipCallbacks: Record<string, any> = {};
  if (config.chartType === 'scatter' && config.labels?.length) {
    tooltipCallbacks.title = (items: any[]) => {
      const idx = items[0]?.dataIndex;
      return (idx != null && config.labels[idx]) || '';
    };
    tooltipCallbacks.label = (item: any) => {
      const xLabel = config.xAxisLabel || 'x';
      const yLabel = config.yAxisLabel || 'y';
      return `${xLabel}: ${formatNumber(item.parsed.x, numFmt)}, ${yLabel}: ${formatNumber(item.parsed.y, numFmt)}`;
    };
  } else if (numFmt) {
    tooltipCallbacks.label = (item: any) => {
      const dsLabel = item.dataset?.label || '';
      const val = item.parsed?.y ?? item.parsed ?? item.raw;
      return `${dsLabel}: ${formatNumber(typeof val === 'number' ? val : Number(val), numFmt)}`;
    };
  }

  // Waterfall tooltip: show the delta value, not the floating bar range
  if (isWaterfall && numFmt) {
    tooltipCallbacks.label = (item: any) => {
      const dsLabel = item.dataset?.label || '';
      const raw = item.raw as [number, number] | undefined;
      const val = raw ? raw[1] - raw[0] : item.parsed?.y ?? 0;
      return `${dsLabel}: ${formatNumber(val, numFmt)}`;
    };
  }

  /* ── Tick formatter ────────────────────────────────────────────── */

  const tickCallback = numFmt
    ? (_value: any, _index: number, _ticks: any) => formatNumber(Number(_value), numFmt)
    : undefined;

  /* ── Build chart options ───────────────────────────────────────── */

  const noAxes = ['pie', 'doughnut', 'treemap'].includes(config.chartType);

  const options: Record<string, unknown> = {
    responsive: true,
    maintainAspectRatio: true,
    aspectRatio: 16 / 9,
    ...(useHorizontal ? { indexAxis: 'y' as const } : {}),
    plugins: {
      legend: {
        position: 'top' as const,
        labels: {
          color: '#a1a1aa',
          font: { family: 'Inter, sans-serif', size: 12 },
          padding: 16,

        },
      },
      tooltip: {
        backgroundColor: '#1a1b23',
        titleColor: '#e4e4e7',
        bodyColor: '#a1a1aa',
        borderColor: '#27272a',
        borderWidth: 1,
        cornerRadius: 8,
        padding: 10,
        titleFont: { family: 'Inter, sans-serif', weight: '600' as const },
        bodyFont: { family: 'Inter, sans-serif' },
        callbacks: Object.keys(tooltipCallbacks).length ? tooltipCallbacks : undefined,
      },
      ...annotationConfig,
    },
    scales: noAxes
      ? {}
      : {
          x: {
            title: config.xAxisLabel
              ? {
                  display: true,
                  text: config.xAxisLabel,
                  color: '#71717a',
                  font: { family: 'Inter, sans-serif', size: 12 },
                }
              : undefined,
            ticks: {
              color: '#71717a',
              font: { family: 'Inter, sans-serif', size: 11 },
              ...(useHorizontal && tickCallback ? { callback: tickCallback } : {}),
            },
            grid: { color: 'rgba(63, 63, 70, 0.3)' },
            stacked: useStacked,
          },
          y: {
            title: config.yAxisLabel
              ? {
                  display: true,
                  text: config.yAxisLabel,
                  color: '#71717a',
                  font: { family: 'Inter, sans-serif', size: 12 },
                }
              : undefined,
            ticks: {
              color: '#71717a',
              font: { family: 'Inter, sans-serif', size: 11 },
              ...(!useHorizontal && tickCallback ? { callback: tickCallback } : {}),
            },
            grid: { color: 'rgba(63, 63, 70, 0.3)' },
            stacked: useStacked,
          },
        },
  };

  /* ── Download handler ──────────────────────────────────────────── */

  const handleDownload = () => {
    const chart = chartRef.current;
    if (!chart) return;
    const url = chart.toBase64Image('image/png', 1);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${config.title.replace(/\s+/g, '_').toLowerCase()}.png`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 100);
  };

  /* ── Component selection ───────────────────────────────────────── */

  const ChartComponent = {
    bar: Bar,
    line: Line,
    area: Line,
    pie: Pie,
    doughnut: Doughnut,
    scatter: Scatter,
    waterfall: Bar,
    fan: Line,
    scenario: Line,
    overlap: Bar,
    treemap: null, // handled separately below
  }[config.chartType] || Bar;

  /* ── Render ─────────────────────────────────────────────────────── */

  return (
    <div className="chart-container">
      <div className="chart-header">
        <span className="chart-title">📊 {config.title}</span>
        <div className="chart-actions">
          <button onClick={handleDownload}>⬇ PNG</button>
          {onToggleTable && <button onClick={onToggleTable}>📋 Table</button>}
        </div>
      </div>
      {isTreemap ? (
        <ChartComponentRaw
          ref={chartRef as any}
          type="treemap"
          data={data as any}
          options={options as any}
        />
      ) : (
        <ChartComponent ref={chartRef as any} data={data as any} options={options as any} />
      )}
    </div>
  );
}

export default memo(ChartRenderer);
