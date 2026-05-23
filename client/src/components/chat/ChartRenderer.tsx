import { useRef } from 'react';
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
import { Bar, Line, Pie, Doughnut, Scatter } from 'react-chartjs-2';
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
  Legend
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

interface Props {
  config: ChartResult;
  onToggleTable?: () => void;
}

export default function ChartRenderer({ config, onToggleTable }: Props) {
  const chartRef = useRef<ChartJS | null>(null);

  const datasets = config.datasets.map((ds, i) => ({
    ...ds,
    backgroundColor: ds.backgroundColor || (
      ['pie', 'doughnut'].includes(config.chartType)
        ? EXEC_PALETTE.slice(0, ds.data.length)
        : EXEC_PALETTE[i % EXEC_PALETTE.length]
    ),
    borderColor: ds.borderColor || (
      ['pie', 'doughnut'].includes(config.chartType)
        ? BORDER_PALETTE.slice(0, ds.data.length)
        : BORDER_PALETTE[i % BORDER_PALETTE.length]
    ),
    borderWidth: ['pie', 'doughnut'].includes(config.chartType) ? 2 : 2,
    fill: config.chartType === 'area',
    tension: config.chartType === 'line' || config.chartType === 'area' ? 0.3 : undefined,
    pointRadius: config.chartType === 'scatter' ? 5 : 3,
    pointHoverRadius: 6,
  }));

  const data = {
    labels: config.labels,
    datasets,
  };

  const options: Record<string, unknown> = {
    responsive: true,
    maintainAspectRatio: true,
    aspectRatio: 16 / 9,
    plugins: {
      legend: {
        position: 'top' as const,
        labels: { color: '#a1a1aa', font: { family: 'Inter, sans-serif', size: 12 }, padding: 16 },
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
      },
    },
    scales: ['pie', 'doughnut'].includes(config.chartType) ? {} : {
      x: {
        title: config.xAxisLabel ? { display: true, text: config.xAxisLabel, color: '#71717a', font: { family: 'Inter, sans-serif', size: 12 } } : undefined,
        ticks: { color: '#71717a', font: { family: 'Inter, sans-serif', size: 11 } },
        grid: { color: 'rgba(63, 63, 70, 0.3)' },
        stacked: config.stacked || false,
      },
      y: {
        title: config.yAxisLabel ? { display: true, text: config.yAxisLabel, color: '#71717a', font: { family: 'Inter, sans-serif', size: 12 } } : undefined,
        ticks: { color: '#71717a', font: { family: 'Inter, sans-serif', size: 11 } },
        grid: { color: 'rgba(63, 63, 70, 0.3)' },
        stacked: config.stacked || false,
      },
    },
  };

  const handleDownload = () => {
    const chart = chartRef.current;
    if (!chart) return;
    const url = chart.toBase64Image('image/png', 1);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${config.title.replace(/\s+/g, '_').toLowerCase()}.png`;
    a.click();
  };

  const ChartComponent = {
    bar: Bar,
    line: Line,
    area: Line,
    pie: Pie,
    doughnut: Doughnut,
    scatter: Scatter,
  }[config.chartType] || Bar;

  return (
    <div className="chart-container">
      <div className="chart-header">
        <span className="chart-title">📊 {config.title}</span>
        <div className="chart-actions">
          <button onClick={handleDownload}>⬇ PNG</button>
          {onToggleTable && <button onClick={onToggleTable}>📋 Table</button>}
        </div>
      </div>
      <ChartComponent ref={chartRef as any} data={data as any} options={options as any} />
    </div>
  );
}
