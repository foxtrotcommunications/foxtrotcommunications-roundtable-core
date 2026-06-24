// @ts-nocheck
import React, { useRef, memo, useEffect, useState } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  RadialLinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Filler,
  Tooltip,
  Legend,
} from 'chart.js';
import { Bar, Line, Pie, Doughnut, Scatter, PolarArea, Radar, Chart as ChartComponentRaw } from 'react-chartjs-2';
import type { ChartResult } from '../../types/message';

// Register Chart.js core components
ChartJS.register(
  CategoryScale,
  LinearScale,
  RadialLinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Filler,
  Tooltip,
  Legend,
);

// Dynamically register optional plugins (won't crash module if packages are missing)
let _pluginsLoaded = false;
(async () => {
  try {
    const annotation = await import('chartjs-plugin-annotation');
    ChartJS.register(annotation.default);
  } catch (e) { console.warn('chartjs-plugin-annotation not available:', e); }
  try {
    const treemap = await import('chartjs-chart-treemap');
    ChartJS.register(treemap.TreemapController, treemap.TreemapElement);
  } catch (e) { console.warn('chartjs-chart-treemap not available:', e); }
  _pluginsLoaded = true;
})();

const EXEC_PALETTE = [
  'rgba(74, 93, 82, 0.85)',     // deep olive      #4A5D52
  'rgba(139, 158, 139, 0.85)',  // sage green       #8B9E8B
  'rgba(181, 196, 177, 0.85)',  // muted sage       #B5C4B1
  'rgba(47, 79, 79, 0.85)',     // dark slate       #2F4F4F
  'rgba(107, 123, 110, 0.85)',  // olive gray       #6B7B6E
  'rgba(61, 90, 76, 0.85)',     // forest olive     #3D5A4C
  'rgba(163, 181, 160, 0.85)',  // light sage       #A3B5A0
  'rgba(85, 107, 92, 0.85)',    // medium olive     #556B5C
  'rgba(122, 139, 114, 0.85)',  // moss             #7A8B72
  'rgba(68, 92, 74, 0.85)',     // pine             #445C4A
  'rgba(155, 175, 147, 0.85)',  // dusty sage       #9BAF93
  'rgba(54, 74, 60, 0.85)',     // deep forest      #364A3C
  'rgba(194, 205, 184, 0.85)',  // pale lichen      #C2CDB8
  'rgba(139, 69, 19, 0.85)',    // muted rust       #8B4513
  'rgba(197, 209, 192, 0.85)',  // sage tint        #C5D1C0
];

/** Derive a fully opaque border color from any CSS color string (rgba or hex) */
function toBorderColor(c: string): string {
  if (c.includes('rgba')) return c.replace(/[\d.]+\)$/, '1)');
  if (c.startsWith('#')) return c; // hex is already opaque
  return c;
}

const BORDER_PALETTE = EXEC_PALETTE.map(toBorderColor);

const WATERFALL_COLORS = {
  increase: 'rgba(74, 93, 82, 0.85)',    // deep olive (positive)
  decrease: 'rgba(139, 69, 19, 0.85)',    // muted rust (negative)
  total: 'rgba(47, 79, 79, 0.85)',        // dark slate (totals)
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
  const borderPalette = palette.map(toBorderColor);
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
      const fillColor = `rgba(74, 93, 82, ${opacity})`;

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
    const isPolar = config.chartType === 'polar';
    const isRadar = config.chartType === 'radar';
    const usePerSliceColors = ['pie', 'doughnut', 'polar'].includes(config.chartType);

    return config.datasets.map((ds, i) => ({
      ...ds,
      backgroundColor: ds.backgroundColor || (
        usePerSliceColors
          ? palette.slice(0, ds.data.length)
          : isRadar
            ? palette[i % palette.length].replace(/[\d.]+\)$/, '0.25)')
            : palette[i % palette.length]
      ),
      borderColor: ds.borderColor || (
        usePerSliceColors
          ? borderPalette.slice(0, ds.data.length)
          : borderPalette[i % borderPalette.length]
      ),
      borderWidth: isScenario ? 3 : isRadar ? 2.5 : 2,
      fill: config.chartType === 'area' || isRadar,
      tension: ['line', 'area', 'scenario'].includes(config.chartType) ? 0.3 : isRadar ? 0.1 : undefined,
      pointRadius: config.chartType === 'scatter' ? 5 : (isScenario ? 4 : isRadar ? 4 : 3),
      pointHoverRadius: isScenario ? 7 : 6,
      pointBackgroundColor: isRadar ? borderPalette[i % borderPalette.length] : undefined,
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

  const noAxes = ['pie', 'doughnut', 'treemap', 'polar', 'radar'].includes(config.chartType);

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
    polar: PolarArea,
    radar: Radar,
    treemap: null, // handled separately below
  }[config.chartType] || Bar;

  /* ── Render ─────────────────────────────────────────────────────── */

  // Catch rendering errors
  const [renderError, setRenderError] = React.useState<string | null>(null);

  if (renderError) {
    return (
      <div className="chart-container" style={{ padding: '24px', color: '#ef4444' }}>
        <div className="chart-header">
          <span className="chart-title">📊 {config.title}</span>
        </div>
        <p style={{ margin: '16px 0', fontSize: '13px' }}>
          Chart rendering error: {renderError}
        </p>
        <pre style={{ fontSize: '11px', color: '#71717a', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {JSON.stringify(config, null, 2).slice(0, 500)}
        </pre>
      </div>
    );
  }

  return (
    <div className="chart-container">
      <div className="chart-header">
        <span className="chart-title">📊 {config.title}</span>
        <div className="chart-actions">
          <button onClick={handleDownload}>⬇ PNG</button>
          {onToggleTable && <button onClick={onToggleTable}>📋 Table</button>}
        </div>
      </div>
      <ChartErrorBoundary onError={(msg) => setRenderError(msg)} chartType={config.chartType}>
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
      </ChartErrorBoundary>
    </div>
  );
}

// Error boundary for chart rendering
class ChartErrorBoundary extends React.Component<
  { children: React.ReactNode; onError: (msg: string) => void; chartType: string },
  { hasError: boolean; error: string }
> {
  state = { hasError: false, error: '' };
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }
  componentDidCatch(error: Error) {
    console.error(`ChartRenderer [${this.props.chartType}] error:`, error);
    this.props.onError(error.message);
  }
  render() {
    if (this.state.hasError) {
      return <p style={{ color: '#ef4444', fontSize: '13px', padding: '16px' }}>Failed to render chart: {this.state.error}</p>;
    }
    return this.props.children;
  }
}

export default memo(ChartRenderer);
