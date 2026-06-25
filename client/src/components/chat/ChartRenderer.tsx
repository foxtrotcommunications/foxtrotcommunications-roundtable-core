// @ts-nocheck
// ChartRenderer — ECharts-powered chart visualization for Roundtable
// Replaces the old Chart.js renderer with richer animations, native rose/nightingale,
// gradient fills, and a premium dark theme.

import React, { useRef, memo, useCallback } from 'react';
import ReactECharts from 'echarts-for-react';
import * as echarts from 'echarts';
import type { ChartResult } from '../../types/message';
import RoseChart from './RoseChart';

/* ═══════════════════════════════════════════════════════════════════
   PALETTE — Pendragon olive-drab
   ═══════════════════════════════════════════════════════════════════ */

const PALETTE = [
  '#4A5D52',  // deep olive
  '#8B9E8B',  // sage green
  '#B5C4B1',  // muted sage
  '#2F4F4F',  // dark slate
  '#6B7B6E',  // olive gray
  '#3D5A4C',  // forest olive
  '#A3B5A0',  // light sage
  '#556B5C',  // medium olive
  '#7A8B72',  // moss
  '#445C4A',  // pine
  '#9BAF93',  // dusty sage
  '#364A3C',  // deep forest
  '#C2CDB8',  // pale lichen
  '#8B4513',  // muted rust
  '#C5D1C0',  // sage tint
];

/* ═══════════════════════════════════════════════════════════════════
   CUSTOM THEME
   ═══════════════════════════════════════════════════════════════════ */

echarts.registerTheme('pendragon', {
  color: PALETTE,
  backgroundColor: 'transparent',
  textStyle: { fontFamily: 'Inter, system-ui, -apple-system, sans-serif', color: '#a1a1aa' },
  title: {
    textStyle: { color: '#e4e4e7', fontWeight: 600, fontSize: 14 },
  },
  legend: {
    textStyle: { color: '#a1a1aa', fontSize: 12 },
    pageTextStyle: { color: '#71717a' },
  },
  categoryAxis: {
    axisLine: { lineStyle: { color: 'rgba(63, 63, 70, 0.5)' } },
    axisTick: { show: false },
    axisLabel: { color: '#71717a', fontSize: 11 },
    splitLine: { lineStyle: { color: 'rgba(63, 63, 70, 0.15)', type: 'dashed' } },
  },
  valueAxis: {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: '#71717a', fontSize: 11 },
    splitLine: { lineStyle: { color: 'rgba(63, 63, 70, 0.2)', type: 'dashed' } },
  },
  tooltip: {
    backgroundColor: '#1a1b23',
    borderColor: '#27272a',
    borderWidth: 1,
    textStyle: { color: '#e4e4e7', fontFamily: 'Inter, sans-serif', fontSize: 12 },
    extraCssText: 'border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.4); padding: 10px 14px;',
  },
});

/* ═══════════════════════════════════════════════════════════════════
   NUMBER FORMATTING
   ═══════════════════════════════════════════════════════════════════ */

function formatNum(value: number, fmt?: any): string {
  if (fmt == null) return String(value);
  let str: string;
  if (fmt.compact) {
    if (Math.abs(value) >= 1e9) str = (value / 1e9).toFixed(1) + 'B';
    else if (Math.abs(value) >= 1e6) str = (value / 1e6).toFixed(1) + 'M';
    else if (Math.abs(value) >= 1e3) str = (value / 1e3).toFixed(1) + 'K';
    else str = value.toFixed(0);
  } else {
    str = value.toLocaleString();
  }
  return (fmt.prefix || '') + str + (fmt.suffix || '');
}

const CUR: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };

function resolveFmt(c: ChartResult) {
  if (c.numberFormat) return c.numberFormat;
  if (c.currency) return { prefix: CUR[c.currency.toUpperCase()] || (c.currency + ' '), compact: true };
  return undefined;
}

/* ═══════════════════════════════════════════════════════════════════
   GRADIENT HELPER
   ═══════════════════════════════════════════════════════════════════ */

function vertGrad(color: string, topOpacity = 'FF', botOpacity = '66') {
  return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
    { offset: 0, color: color + topOpacity },
    { offset: 1, color: color + botOpacity },
  ]);
}

/* ═══════════════════════════════════════════════════════════════════
   ANNOTATION → markLine
   ═══════════════════════════════════════════════════════════════════ */

function buildMarkLines(annotations: any[]) {
  if (!annotations?.length) return undefined;
  return {
    markLine: {
      silent: true,
      symbol: 'none',
      lineStyle: { type: 'dashed', width: 2 },
      label: {
        show: true,
        color: '#a1a1aa',
        fontSize: 11,
        fontFamily: 'Inter, sans-serif',
        formatter: (p: any) => p.name,
        position: 'insideEndTop',
        backgroundColor: '#1a1b23',
        padding: [3, 6],
        borderRadius: 3,
      },
      data: annotations.map((a) => ({
        name: a.label || '',
        [a.axis === 'x' ? 'xAxis' : 'yAxis']: a.value,
        lineStyle: { color: a.color || '#8B4513' },
        label: { color: a.color || '#a1a1aa' },
      })),
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════
   SHARED TOOLTIP FORMATTER
   ═══════════════════════════════════════════════════════════════════ */

function axisTooltip(fmt: any) {
  if (!fmt) return {};
  return {
    formatter: (params: any) => {
      const items = Array.isArray(params) ? params : [params];
      let html = `<div style="font-weight:600;margin-bottom:4px">${items[0].axisValue || items[0].name}</div>`;
      items.forEach((p: any) => {
        const v = typeof p.value === 'number' ? p.value : (Array.isArray(p.value) ? p.value[1] : p.value);
        html += `<div>${p.marker} ${p.seriesName}: <strong>${formatNum(v, fmt)}</strong></div>`;
      });
      return html;
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════
   OPTIONS BUILDERS
   ═══════════════════════════════════════════════════════════════════ */

function buildBar(c: ChartResult, fmt: any, pal: string[]) {
  const hz = c.horizontal || c.chartType === 'overlap';
  const marks = buildMarkLines(c.annotations);

  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...axisTooltip(fmt) },
    legend: { show: c.datasets.length > 1, top: 4 },
    grid: { left: '3%', right: '4%', bottom: '6%', top: c.datasets.length > 1 ? '14%' : '6%', containLabel: true },
    [hz ? 'yAxis' : 'xAxis']: {
      type: 'category',
      data: c.labels,
      axisLabel: { rotate: !hz && c.labels.length > 7 ? 35 : 0, fontSize: 11 },
      name: hz ? c.yAxisLabel : c.xAxisLabel,
      nameTextStyle: { color: '#71717a', fontSize: 11 },
    },
    [hz ? 'xAxis' : 'yAxis']: {
      type: 'value',
      name: hz ? c.xAxisLabel : c.yAxisLabel,
      nameTextStyle: { color: '#71717a', fontSize: 11 },
      axisLabel: { formatter: fmt ? (v: number) => formatNum(v, fmt) : undefined },
    },
    series: c.datasets.map((ds, i) => ({
      name: ds.label,
      type: 'bar',
      data: ds.data,
      stack: (c.stacked || c.chartType === 'overlap') ? 'total' : undefined,
      barMaxWidth: 40,
      itemStyle: {
        color: vertGrad(pal[i % pal.length]),
        borderRadius: hz ? [0, 4, 4, 0] : [4, 4, 0, 0],
      },
      emphasis: { itemStyle: { shadowBlur: 12, shadowColor: 'rgba(0,0,0,0.25)' } },
      animationDelay: (idx: number) => idx * 40 + i * 200,
      ...marks,
    })),
    animationEasing: 'cubicOut',
    animationDuration: 800,
  };
}

function buildLine(c: ChartResult, fmt: any, pal: string[], isArea: boolean, isScenario: boolean) {
  const marks = buildMarkLines(c.annotations);

  return {
    tooltip: { trigger: 'axis', ...axisTooltip(fmt) },
    legend: { show: c.datasets.length > 1, top: 4 },
    grid: { left: '3%', right: '4%', bottom: '6%', top: '14%', containLabel: true },
    xAxis: {
      type: 'category',
      data: c.labels,
      name: c.xAxisLabel,
      nameTextStyle: { color: '#71717a' },
      boundaryGap: false,
    },
    yAxis: {
      type: 'value',
      name: c.yAxisLabel,
      nameTextStyle: { color: '#71717a' },
      axisLabel: { formatter: fmt ? (v: number) => formatNum(v, fmt) : undefined },
    },
    series: c.datasets.map((ds, i) => ({
      name: ds.label,
      type: 'line',
      data: ds.data,
      smooth: 0.3,
      symbol: 'circle',
      symbolSize: isScenario ? 5 : 4,
      showSymbol: (ds.data?.length || 0) <= 20,
      lineStyle: { width: isScenario ? 3 : 2.5, color: pal[i % pal.length] },
      itemStyle: { color: pal[i % pal.length] },
      areaStyle: isArea ? {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: pal[i % pal.length] + 'AA' },
          { offset: 1, color: pal[i % pal.length] + '08' },
        ]),
      } : undefined,
      stack: c.stacked ? 'total' : undefined,
      emphasis: { focus: 'series', lineStyle: { width: 4 } },
      ...marks,
    })),
    animationEasing: 'cubicOut',
    animationDuration: 1200,
  };
}

function buildPie(c: ChartResult, fmt: any, pal: string[], isDoughnut: boolean) {
  const d0 = c.datasets[0];
  const data = c.labels.map((label, i) => ({
    name: label,
    value: d0.data[i],
    itemStyle: { color: pal[i % pal.length] },
  }));

  return {
    tooltip: {
      trigger: 'item',
      formatter: (p: any) => {
        const val = fmt ? formatNum(p.value, fmt) : p.value;
        return `<strong>${p.name}</strong><br/>${p.marker} ${val} (${p.percent}%)`;
      },
    },
    legend: {
      orient: 'vertical',
      right: '5%',
      top: 'center',
      textStyle: { color: '#a1a1aa', fontSize: 11 },
    },
    series: [{
      type: 'pie',
      radius: isDoughnut ? ['42%', '72%'] : ['0%', '72%'],
      center: ['40%', '50%'],
      data,
      label: {
        show: true,
        color: '#a1a1aa',
        fontSize: 11,
        formatter: '{b}: {d}%',
      },
      labelLine: { lineStyle: { color: 'rgba(161,161,170,0.4)' } },
      emphasis: {
        itemStyle: { shadowBlur: 16, shadowColor: 'rgba(0,0,0,0.35)' },
        label: { fontSize: 13, fontWeight: 'bold' },
        scaleSize: 8,
      },
      itemStyle: {
        borderColor: '#0f0f12',
        borderWidth: 2,
      },
      animationType: 'expansion',
      animationDuration: 1000,
      animationEasing: 'cubicOut',
    }],
  };
}

function buildScatter(c: ChartResult, fmt: any, pal: string[]) {
  return {
    tooltip: {
      trigger: 'item',
      formatter: (p: any) => {
        const xVal = fmt ? formatNum(p.value[0], fmt) : p.value[0];
        const yVal = fmt ? formatNum(p.value[1], fmt) : p.value[1];
        const label = c.labels?.[p.dataIndex] || '';
        return `<strong>${label || p.seriesName}</strong><br/>${c.xAxisLabel || 'x'}: ${xVal}<br/>${c.yAxisLabel || 'y'}: ${yVal}`;
      },
    },
    grid: { left: '3%', right: '4%', bottom: '8%', top: '8%', containLabel: true },
    xAxis: {
      type: 'value',
      name: c.xAxisLabel,
      nameTextStyle: { color: '#71717a' },
      axisLabel: { formatter: fmt ? (v: number) => formatNum(v, fmt) : undefined },
    },
    yAxis: {
      type: 'value',
      name: c.yAxisLabel,
      nameTextStyle: { color: '#71717a' },
      axisLabel: { formatter: fmt ? (v: number) => formatNum(v, fmt) : undefined },
    },
    series: c.datasets.map((ds, i) => ({
      name: ds.label,
      type: 'scatter',
      data: ds.data.map((d: any) => [d.x, d.y]),
      symbolSize: 10,
      itemStyle: {
        color: pal[i % pal.length],
        shadowBlur: 4,
        shadowColor: pal[i % pal.length] + '55',
      },
      emphasis: { itemStyle: { shadowBlur: 12, borderWidth: 2, borderColor: '#fff' } },
    })),
    animationDuration: 800,
  };
}

function buildWaterfall(c: ChartResult, fmt: any, pal: string[]) {
  const raw = c.datasets[0]?.data as number[] ?? [];
  const wColors = c.colors?.length === 3
    ? { inc: c.colors[0], dec: c.colors[1], tot: c.colors[2] }
    : { inc: '#4A5D52', dec: '#8B4513', tot: '#2F4F4F' };

  let running = 0;
  const base: number[] = [];
  const delta: number[] = [];
  const colors: string[] = [];

  raw.forEach((val, i) => {
    const isTotal = c.totals?.[i] === true;
    if (isTotal) {
      base.push(0);
      delta.push(running);
      colors.push(wColors.tot);
    } else {
      const prev = running;
      running += val;
      base.push(val >= 0 ? prev : running);
      delta.push(Math.abs(val));
      colors.push(val >= 0 ? wColors.inc : wColors.dec);
    }
  });

  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: any) => {
        const items = Array.isArray(params) ? params : [params];
        const visible = items.find((p: any) => p.seriesIndex === 1);
        if (!visible) return '';
        const idx = visible.dataIndex;
        const val = raw[idx];
        const isTotal = c.totals?.[idx] === true;
        const label = isTotal ? `Total: ${formatNum(running, fmt)}` : `${val >= 0 ? '+' : ''}${formatNum(val, fmt)}`;
        return `<strong>${visible.axisValue}</strong><br/>${label}`;
      },
    },
    grid: { left: '3%', right: '4%', bottom: '6%', top: '6%', containLabel: true },
    xAxis: {
      type: 'category',
      data: c.labels,
      axisLabel: { rotate: c.labels.length > 6 ? 30 : 0 },
    },
    yAxis: {
      type: 'value',
      axisLabel: { formatter: fmt ? (v: number) => formatNum(v, fmt) : undefined },
    },
    series: [
      {
        name: 'base',
        type: 'bar',
        stack: 'waterfall',
        data: base,
        itemStyle: { color: 'transparent' },
        emphasis: { itemStyle: { color: 'transparent' } },
      },
      {
        name: c.datasets[0]?.label || 'Value',
        type: 'bar',
        stack: 'waterfall',
        data: delta.map((v, i) => ({
          value: v,
          itemStyle: {
            color: vertGrad(colors[i]),
            borderRadius: [4, 4, 0, 0],
          },
        })),
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.3)' } },
        animationDelay: (idx: number) => idx * 80,
      },
    ],
    animationEasing: 'cubicOut',
    animationDuration: 900,
  };
}

function buildTreemap(c: ChartResult, pal: string[]) {
  const treeData = c.datasets[0]?.data as any[] ?? [];
  const hasGroups = treeData.some((d: any) => d.group);

  let data: any[];
  if (hasGroups) {
    const groups: Record<string, any[]> = {};
    treeData.forEach((d) => {
      const g = d.group || 'Other';
      if (!groups[g]) groups[g] = [];
      groups[g].push({ name: d.label, value: d.value });
    });
    data = Object.entries(groups).map(([name, children]) => ({ name, children }));
  } else {
    data = treeData.map((d) => ({ name: d.label, value: d.value }));
  }

  return {
    tooltip: {
      trigger: 'item',
      formatter: (p: any) => `<strong>${p.name}</strong><br/>Value: ${p.value?.toLocaleString?.() || p.value}`,
    },
    series: [{
      type: 'treemap',
      data,
      width: '95%',
      height: '90%',
      roam: false,
      nodeClick: false,
      breadcrumb: { show: false },
      label: {
        show: true,
        color: '#fff',
        fontSize: 12,
        fontWeight: 'bold',
        fontFamily: 'Inter, sans-serif',
        formatter: '{b}',
      },
      upperLabel: hasGroups ? { show: true, height: 24, color: '#ddd', fontSize: 11 } : undefined,
      itemStyle: {
        borderColor: '#0f0f12',
        borderWidth: 2,
        gapWidth: 2,
      },
      levels: [
        { itemStyle: { borderWidth: 3, gapWidth: 4 } },
        {
          colorSaturation: [0.35, 0.65],
          itemStyle: { borderWidth: 1, gapWidth: 2, borderColorSaturation: 0.6 },
        },
      ],
      animationDuration: 1000,
      animationEasing: 'cubicOut',
    }],
  };
}

function buildFan(c: ChartResult, fmt: any, pal: string[]) {
  // Fan: first dataset = central projection, subsequent pairs = upper/lower bounds
  const bandOpacities = ['55', '30', '18'];

  return {
    tooltip: { trigger: 'axis', ...axisTooltip(fmt) },
    legend: { show: true, top: 4 },
    grid: { left: '3%', right: '4%', bottom: '6%', top: '14%', containLabel: true },
    xAxis: {
      type: 'category',
      data: c.labels,
      name: c.xAxisLabel,
      nameTextStyle: { color: '#71717a' },
      boundaryGap: false,
    },
    yAxis: {
      type: 'value',
      name: c.yAxisLabel,
      nameTextStyle: { color: '#71717a' },
      axisLabel: { formatter: fmt ? (v: number) => formatNum(v, fmt) : undefined },
    },
    series: c.datasets.map((ds, i) => {
      if (i === 0) {
        // Central line
        return {
          name: ds.label,
          type: 'line',
          data: ds.data,
          smooth: 0.3,
          symbol: 'circle',
          symbolSize: 4,
          lineStyle: { width: 3, color: pal[0] },
          itemStyle: { color: pal[0] },
          z: 10,
        };
      }
      // Confidence bands
      const bandIdx = Math.floor((i - 1) / 2);
      const opacity = bandOpacities[Math.min(bandIdx, bandOpacities.length - 1)];
      const isUpper = i % 2 === 1;

      return {
        name: ds.label,
        type: 'line',
        data: ds.data,
        smooth: 0.3,
        symbol: 'none',
        lineStyle: { width: 0 },
        areaStyle: isUpper ? {
          color: pal[0] + opacity,
        } : {
          color: pal[0] + opacity,
        },
        stack: `band${bandIdx}`,
        z: 5 - bandIdx,
      };
    }),
    animationDuration: 1200,
    animationEasing: 'cubicOut',
  };
}

function buildRadar(c: ChartResult, pal: string[]) {
  const maxVal = Math.max(...c.datasets.flatMap((ds) => ds.data as number[]));

  return {
    tooltip: { trigger: 'item' },
    legend: { show: c.datasets.length > 1, top: 4, textStyle: { color: '#a1a1aa' } },
    radar: {
      indicator: c.labels.map((name) => ({ name, max: maxVal * 1.15 })),
      shape: 'polygon',
      splitNumber: 4,
      axisName: { color: '#a1a1aa', fontSize: 11 },
      splitLine: { lineStyle: { color: 'rgba(63, 63, 70, 0.3)' } },
      splitArea: {
        areaStyle: {
          color: ['rgba(63, 63, 70, 0.05)', 'rgba(63, 63, 70, 0.1)'],
        },
      },
      axisLine: { lineStyle: { color: 'rgba(63, 63, 70, 0.3)' } },
    },
    series: [{
      type: 'radar',
      data: c.datasets.map((ds, i) => ({
        name: ds.label,
        value: ds.data,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { width: 2.5, color: pal[i % pal.length] },
        itemStyle: { color: pal[i % pal.length] },
        areaStyle: { color: pal[i % pal.length] + '30' },
      })),
      animationDuration: 1000,
    }],
  };
}

function buildPolar(c: ChartResult, fmt: any, pal: string[]) {
  // Nightingale rose — same-angle slices, variable radius
  const d0 = c.datasets[0];
  const data = c.labels.map((label, i) => ({
    name: label,
    value: d0.data[i],
    itemStyle: { color: pal[i % pal.length] },
  }));

  return {
    tooltip: {
      trigger: 'item',
      formatter: (p: any) => {
        const val = fmt ? formatNum(p.value, fmt) : p.value;
        return `<strong>${p.name}</strong><br/>${p.marker} ${val} (${p.percent}%)`;
      },
    },
    legend: {
      orient: 'vertical',
      right: '3%',
      top: 'center',
      textStyle: { color: '#a1a1aa', fontSize: 11 },
    },
    series: [{
      type: 'pie',
      roseType: 'area',
      radius: ['12%', '70%'],
      center: ['40%', '50%'],
      data,
      label: { color: '#a1a1aa', fontSize: 11, formatter: '{b}' },
      labelLine: { lineStyle: { color: 'rgba(161,161,170,0.4)' } },
      itemStyle: { borderColor: '#0f0f12', borderWidth: 2 },
      emphasis: {
        itemStyle: { shadowBlur: 16, shadowColor: 'rgba(0,0,0,0.35)' },
        scaleSize: 6,
      },
      animationType: 'expansion',
      animationDuration: 1200,
      animationEasing: 'cubicOut',
    }],
  };
}

/* ═══════════════════════════════════════════════════════════════════
   MASTER OPTIONS BUILDER
   ═══════════════════════════════════════════════════════════════════ */

function buildOptions(config: ChartResult, palette: string[]): any | null {
  const fmt = resolveFmt(config);

  switch (config.chartType) {
    case 'bar':
    case 'overlap':
      return buildBar(config, fmt, palette);
    case 'line':
      return buildLine(config, fmt, palette, false, false);
    case 'area':
      return buildLine(config, fmt, palette, true, false);
    case 'scenario':
      return buildLine(config, fmt, palette, false, true);
    case 'pie':
      return buildPie(config, fmt, palette, false);
    case 'doughnut':
      return buildPie(config, fmt, palette, true);
    case 'scatter':
      return buildScatter(config, fmt, palette);
    case 'waterfall':
      return buildWaterfall(config, fmt, palette);
    case 'treemap':
      return buildTreemap(config, palette);
    case 'fan':
      return buildFan(config, fmt, palette);
    case 'radar':
      return buildRadar(config, palette);
    case 'polar':
      return buildPolar(config, fmt, palette);
    case 'rose':
      return null; // handled by custom RoseChart component
    default:
      return buildBar(config, fmt, palette);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   COMPONENT
   ═══════════════════════════════════════════════════════════════════ */

interface Props {
  config: ChartResult;
  onToggleTable?: () => void;
}

function ChartRenderer({ config, onToggleTable }: Props) {
  const chartRef = useRef<any>(null);
  const palette = config.colors?.length ? config.colors : PALETTE;

  // Smart rose detection: if Arthur sent a bar/polar chart but the datasets
  // are clearly theta+radius data, auto-upgrade to rose rendering.
  const looksLikeRose = config.datasets.length === 2
    && config.datasets.some(d => /theta|share|slice|angle/i.test(d.label))
    && config.datasets.some(d => /radius|change|magnitude|growth/i.test(d.label))
    && Array.isArray(config.datasets[0]?.data)
    && config.datasets[0].data.every((v: any) => typeof v === 'number');

  const isRose = config.chartType === 'rose' || (looksLikeRose && ['bar', 'polar'].includes(config.chartType));

  /* ── Download handler ──────────────────────────────────────────── */

  const handleDownload = useCallback(() => {
    const instance = chartRef.current?.getEchartsInstance?.();
    if (!instance) return;
    const url = instance.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#0f0f12' });
    const a = document.createElement('a');
    a.href = url;
    a.download = `${config.title.replace(/\s+/g, '_').toLowerCase()}.png`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 100);
  }, [config.title]);

  /* ── Build options ─────────────────────────────────────────────── */

  const options = isRose ? null : buildOptions(config, palette);

  /* ── Render error state ────────────────────────────────────────── */

  if (!isRose && !options) {
    return (
      <div className="chart-container" style={{ padding: '24px', color: '#ef4444' }}>
        <div className="chart-header">
          <span className="chart-title">📊 {config.title}</span>
        </div>
        <p style={{ margin: '16px 0', fontSize: '13px' }}>
          Unsupported chart type: {config.chartType}
        </p>
      </div>
    );
  }

  /* ── Render ─────────────────────────────────────────────────────── */

  return (
    <div className="chart-container">
      <div className="chart-header">
        <span className="chart-title">📊 {config.title}</span>
        <div className="chart-actions">
          {!isRose && <button onClick={handleDownload}>⬇ PNG</button>}
          {onToggleTable && <button onClick={onToggleTable}>📋 Table</button>}
        </div>
      </div>
      {isRose ? (
        <RoseChart
          labels={config.labels || []}
          thetaValues={(config.datasets[0]?.data as number[]) || []}
          radiusValues={(config.datasets[1]?.data as number[]) || []}
          palette={palette}
          thetaLabel={config.datasets[0]?.label || 'Share'}
          radiusLabel={config.datasets[1]?.label || 'Change'}
        />
      ) : (
        <ReactECharts
          ref={chartRef}
          option={options}
          theme="pendragon"
          style={{ height: '420px', width: '100%' }}
          opts={{ renderer: 'canvas' }}
          notMerge={true}
        />
      )}
    </div>
  );
}

export default memo(ChartRenderer);
