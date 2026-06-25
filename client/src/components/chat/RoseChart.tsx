// @ts-nocheck
// RoseChart — Custom coxcomb/rose chart with variable θ (angle) and variable r (radius)
// Used when chartType === 'rose' in ChartRenderer
//
// Data contract (passed via render_chart tool):
//   datasets[0].data = theta values   (% shares — angular widths, normalized to 360°)
//   datasets[1].data = radius values  (% change — petal lengths, can be negative)
//   labels = slice labels

import React, { useRef, useEffect, useState, useCallback, memo } from 'react';

const FONT_FAMILY = 'Inter, system-ui, -apple-system, sans-serif';

/* ── Easing ─────────────────────────────────────────────────────────── */

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/* ── Color helpers ──────────────────────────────────────────────────── */

function parseRgba(c: string): [number, number, number, number] {
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (m) return [+m[1], +m[2], +m[3], m[4] != null ? +m[4] : 1];
  return [74, 93, 82, 0.85]; // fallback to deep olive
}

function rgbaStr(r: number, g: number, b: number, a: number): string {
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/* ── Component ──────────────────────────────────────────────────────── */

interface RoseChartProps {
  labels: string[];
  thetaValues: number[];
  radiusValues: number[];
  palette: string[];
  thetaLabel?: string;
  radiusLabel?: string;
  numberFormat?: { prefix?: string; suffix?: string; compact?: boolean };
}

function RoseChart({
  labels,
  thetaValues,
  radiusValues,
  palette,
  thetaLabel = 'Share',
  radiusLabel = 'Change',
}: RoseChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    label: string;
    theta: number;
    radius: number;
  } | null>(null);

  // Store geometry for hit-testing
  const geoRef = useRef<
    Array<{
      startAngle: number;
      endAngle: number;
      outerR: number;
      label: string;
      theta: number;
      radius: number;
    }>
  >([]);

  /* ── Drawing ───────────────────────────────────────────────────── */

  const draw = useCallback(
    (progress: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);

      const W = rect.width;
      const H = rect.height;
      const cx = W / 2;
      const cy = H / 2;
      const labelMargin = 90;
      const maxR = Math.min(W, H) / 2 - labelMargin;
      const baselineR = maxR * 0.45; // 0% reference ring

      // Normalize theta → angles
      const thetaSum = thetaValues.reduce((a, b) => a + Math.abs(b), 0) || 1;
      const angles = thetaValues.map((v) => (Math.abs(v) / thetaSum) * Math.PI * 2);

      // Radius scaling
      const maxAbsR = Math.max(...radiusValues.map(Math.abs), 0.01);
      const rScale = (maxR - baselineR) * 0.85;

      // ── Clear ───────────────────────────────────────────────────
      ctx.clearRect(0, 0, W, H);

      // ── Background glow ─────────────────────────────────────────
      const bgGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * 1.2);
      bgGrad.addColorStop(0, 'rgba(74, 93, 82, 0.04)');
      bgGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, W, H);

      // ── Concentric reference rings ──────────────────────────────
      const ringRadii = [baselineR * 0.5, baselineR, baselineR + rScale * 0.5];
      const ringLabels = ['', '0%', ''];

      for (let ri = 0; ri < ringRadii.length; ri++) {
        ctx.beginPath();
        ctx.arc(cx, cy, ringRadii[ri], 0, Math.PI * 2);
        ctx.strokeStyle =
          ri === 1 ? 'rgba(161, 161, 170, 0.35)' : 'rgba(161, 161, 170, 0.12)';
        ctx.lineWidth = ri === 1 ? 1.5 : 0.8;
        ctx.setLineDash(ri === 1 ? [6, 4] : [3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);

        if (ringLabels[ri]) {
          ctx.fillStyle = 'rgba(161, 161, 170, 0.45)';
          ctx.font = `10px ${FONT_FAMILY}`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(ringLabels[ri], cx + ringRadii[ri] + 3, cy - 2);
        }
      }

      // ── Draw petals ─────────────────────────────────────────────
      let currentAngle = -Math.PI / 2; // start from 12 o'clock
      const geo: typeof geoRef.current = [];

      for (let i = 0; i < labels.length; i++) {
        const angle = angles[i];
        if (angle < 0.005) {
          // skip negligible slices
          geo.push({
            startAngle: currentAngle,
            endAngle: currentAngle,
            outerR: 0,
            label: labels[i],
            theta: thetaValues[i],
            radius: radiusValues[i],
          });
          continue;
        }

        const rv = radiusValues[i] || 0;
        const petalR = baselineR + (rv / maxAbsR) * rScale;
        const clampedR = Math.max(15, petalR); // ensure minimum visibility

        // Apply animation progress with stagger
        const stagger = i / labels.length;
        const localP = Math.max(0, Math.min(1, (progress - stagger * 0.3) / 0.7));
        const animR = clampedR * easeOutCubic(localP);

        const startAngle = currentAngle;
        const endAngle = currentAngle + angle;

        geo.push({
          startAngle,
          endAngle,
          outerR: clampedR,
          label: labels[i],
          theta: thetaValues[i],
          radius: rv,
        });

        // ── Petal fill ──────────────────────────────────────────
        const [pr, pg, pb] = parseRgba(palette[i % palette.length]);
        const isNeg = rv < 0;

        // Radial gradient: darker at center, lighter at edge
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, animR);
        grad.addColorStop(0, rgbaStr(pr, pg, pb, 0.35));
        grad.addColorStop(0.6, rgbaStr(pr, pg, pb, isNeg ? 0.7 : 0.65));
        grad.addColorStop(1, rgbaStr(pr, pg, pb, isNeg ? 0.9 : 0.85));

        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, animR, startAngle, endAngle);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        // ── Petal border ────────────────────────────────────────
        ctx.strokeStyle = rgbaStr(pr, pg, pb, 1);
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // ── Inner glow line (if negative, add a warm accent) ────
        if (isNeg && localP > 0.5) {
          ctx.beginPath();
          ctx.arc(cx, cy, animR - 2, startAngle + 0.01, endAngle - 0.01);
          ctx.strokeStyle = 'rgba(139, 69, 19, 0.4)'; // muted rust accent
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // ── Petal value label (inside large petals) ─────────────
        if (angle > 0.2 && localP > 0.8) {
          const midAngle = startAngle + angle / 2;
          const textR = animR * 0.65;
          const tx = cx + Math.cos(midAngle) * textR;
          const ty = cy + Math.sin(midAngle) * textR;

          ctx.save();
          ctx.translate(tx, ty);
          // Rotate text to follow the petal direction
          let textRot = midAngle;
          if (textRot > Math.PI / 2 && textRot < Math.PI * 1.5) {
            textRot += Math.PI; // flip for readability
          }
          if (textRot < -Math.PI / 2 && textRot > -Math.PI * 1.5) {
            textRot += Math.PI;
          }
          ctx.rotate(textRot);

          ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
          ctx.font = `bold 11px ${FONT_FAMILY}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const sign = rv >= 0 ? '+' : '';
          ctx.fillText(`${sign}${rv.toFixed(1)}%`, 0, 0);
          ctx.restore();
        }

        currentAngle = endAngle;
      }

      // ── Outer labels with leader lines (collision-resolved) ────
      if (progress > 0.6) {
        const labelOpacity = Math.min(1, (progress - 0.6) / 0.4);
        const MIN_LABEL_GAP = 22; // minimum vertical px between label centers

        // Phase 1: collect raw label positions into left/right buckets
        interface LabelEntry {
          idx: number;
          midAngle: number;
          petalR: number;
          rawY: number;       // ideal Y from geometry
          resolvedY: number;  // Y after collision fix
          anchorX: number;    // X where leader line meets label column
          isRight: boolean;
        }
        const leftLabels: LabelEntry[] = [];
        const rightLabels: LabelEntry[] = [];

        currentAngle = -Math.PI / 2;
        for (let i = 0; i < labels.length; i++) {
          const angle = angles[i];
          if (angle < 0.005) { currentAngle += angle; continue; }

          const rv = radiusValues[i] || 0;
          const petalR = Math.max(15, baselineR + (rv / maxAbsR) * rScale);
          const midAngle = currentAngle + angle / 2;
          const labelR = Math.max(petalR, baselineR) + 22;
          const lx = cx + Math.cos(midAngle) * labelR;
          const ly = cy + Math.sin(midAngle) * labelR;
          const isRight = midAngle > -Math.PI / 2 && midAngle < Math.PI / 2;

          const entry: LabelEntry = {
            idx: i, midAngle, petalR,
            rawY: ly, resolvedY: ly,
            anchorX: lx, isRight,
          };
          (isRight ? rightLabels : leftLabels).push(entry);
          currentAngle += angle;
        }

        // Phase 2: resolve collisions per side
        function resolveCollisions(bucket: LabelEntry[]) {
          if (bucket.length <= 1) return;
          // sort by raw Y so we process top-to-bottom
          bucket.sort((a, b) => a.rawY - b.rawY);

          // iterative relaxation (3 passes handles most cases)
          for (let pass = 0; pass < 3; pass++) {
            for (let j = 1; j < bucket.length; j++) {
              const gap = bucket[j].resolvedY - bucket[j - 1].resolvedY;
              if (gap < MIN_LABEL_GAP) {
                const push = (MIN_LABEL_GAP - gap) / 2;
                bucket[j - 1].resolvedY -= push;
                bucket[j].resolvedY += push;
              }
            }
          }

          // clamp to canvas bounds (leave 8px padding)
          for (const entry of bucket) {
            entry.resolvedY = Math.max(8, Math.min(H - 8, entry.resolvedY));
          }
        }
        resolveCollisions(leftLabels);
        resolveCollisions(rightLabels);

        // Phase 3: draw with elbow leader lines
        const allLabels = [...leftLabels, ...rightLabels];
        for (const entry of allLabels) {
          const { idx, midAngle, petalR, resolvedY, anchorX, isRight } = entry;
          const tickDir = isRight ? 1 : -1;

          // Leader line: petal edge → elbow → label
          const lineStart = petalR + 4;
          const startX = cx + Math.cos(midAngle) * lineStart;
          const startY = cy + Math.sin(midAngle) * lineStart;

          ctx.beginPath();
          ctx.moveTo(startX, startY);
          // go to anchor X at the resolved Y (elbow)
          ctx.lineTo(anchorX, resolvedY);
          // horizontal tick
          ctx.lineTo(anchorX + tickDir * 12, resolvedY);
          ctx.strokeStyle = `rgba(161, 161, 170, ${0.35 * labelOpacity})`;
          ctx.lineWidth = 1;
          ctx.stroke();

          // Label text
          ctx.fillStyle = `rgba(161, 161, 170, ${labelOpacity})`;
          ctx.font = `11px ${FONT_FAMILY}`;
          ctx.textAlign = isRight ? 'left' : 'right';
          ctx.textBaseline = 'middle';
          const textX = anchorX + tickDir * 16;
          const displayLabel =
            labels[idx].length > 20
              ? labels[idx].substring(0, 18) + '…'
              : labels[idx];
          ctx.fillText(displayLabel, textX, resolvedY);

          // Theta annotation
          ctx.fillStyle = `rgba(161, 161, 170, ${0.6 * labelOpacity})`;
          ctx.font = `9px ${FONT_FAMILY}`;
          const thetaDeg = (thetaValues[idx] / thetaSum * 360).toFixed(1);
          ctx.fillText(`θ ${thetaDeg}°`, textX, resolvedY + 13);
        }
      }

      // ── Center dot ──────────────────────────────────────────────
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(161, 161, 170, 0.5)';
      ctx.fill();

      geoRef.current = geo;
    },
    [labels, thetaValues, radiusValues, palette],
  );

  /* ── Animation loop ────────────────────────────────────────────── */

  useEffect(() => {
    const DURATION = 1200; // ms
    startTimeRef.current = performance.now();

    const animate = (now: number) => {
      const elapsed = now - startTimeRef.current;
      const progress = Math.min(1, elapsed / DURATION);
      draw(progress);
      if (progress < 1) {
        animRef.current = requestAnimationFrame(animate);
      }
    };

    animRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animRef.current);
  }, [draw]);

  /* ── Resize handler ────────────────────────────────────────────── */

  useEffect(() => {
    const handleResize = () => draw(1);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [draw]);

  /* ── Hit-test for tooltip ──────────────────────────────────────── */

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const cx = rect.width / 2;
      const cy = rect.height / 2;

      const dx = mx - cx;
      const dy = my - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let angle = Math.atan2(dy, dx);

      // Normalize angle to match our drawing (starts at -PI/2)
      // atan2 range is [-PI, PI], our petals start at -PI/2
      // We need to check each petal's startAngle..endAngle

      let found = false;
      for (const g of geoRef.current) {
        if (g.outerR === 0) continue;

        // Check if angle is within this slice
        let inAngle = false;
        let sa = g.startAngle;
        let ea = g.endAngle;

        // Normalize
        while (sa > Math.PI) sa -= Math.PI * 2;
        while (sa < -Math.PI) sa += Math.PI * 2;
        while (ea > Math.PI) ea -= Math.PI * 2;
        while (ea < -Math.PI) ea += Math.PI * 2;

        if (sa <= ea) {
          inAngle = angle >= sa && angle <= ea;
        } else {
          inAngle = angle >= sa || angle <= ea;
        }

        if (inAngle && dist <= g.outerR) {
          setTooltip({
            x: mx,
            y: my,
            label: g.label,
            theta: g.theta,
            radius: g.radius,
          });
          found = true;
          break;
        }
      }

      if (!found) setTooltip(null);
    },
    [],
  );

  const handleMouseLeave = useCallback(() => setTooltip(null), []);

  /* ── Legend data ───────────────────────────────────────────────── */

  const thetaSum = thetaValues.reduce((a, b) => a + Math.abs(b), 0) || 1;

  /* ── Render ────────────────────────────────────────────────────── */

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: '100%' }}
    >
      {/* Canvas */}
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{
          width: '100%',
          aspectRatio: '1',
          cursor: tooltip ? 'crosshair' : 'default',
        }}
      />

      {/* Tooltip */}
      {tooltip && (
        <div
          style={{
            position: 'absolute',
            left: tooltip.x,
            top: tooltip.y,
            background: '#1a1b23',
            border: '1px solid #27272a',
            borderRadius: 8,
            padding: '10px 14px',
            color: '#e4e4e7',
            fontSize: 12,
            fontFamily: FONT_FAMILY,
            pointerEvents: 'none',
            transform: 'translate(-50%, -120%)',
            whiteSpace: 'nowrap',
            zIndex: 10,
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {tooltip.label}
          </div>
          <div style={{ color: '#a1a1aa' }}>
            θ {thetaLabel}: {tooltip.theta.toFixed(1)}% →{' '}
            {((tooltip.theta / thetaSum) * 360).toFixed(1)}°
          </div>
          <div
            style={{
              color: tooltip.radius >= 0 ? '#4A5D52' : '#8B4513',
              fontWeight: 500,
            }}
          >
            r {radiusLabel}:{' '}
            {tooltip.radius >= 0 ? '+' : ''}
            {tooltip.radius.toFixed(1)}%
          </div>
        </div>
      )}

      {/* Axis legend */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          gap: 24,
          padding: '8px 0 4px',
          fontSize: 11,
          fontFamily: FONT_FAMILY,
          color: '#71717a',
        }}
      >
        <span>
          <strong style={{ color: '#a1a1aa' }}>θ</strong> = {thetaLabel}
        </span>
        <span>
          <strong style={{ color: '#a1a1aa' }}>r</strong> = {radiusLabel}
        </span>
        <span style={{ opacity: 0.6 }}>
          ── 0% baseline
        </span>
      </div>
    </div>
  );
}

export default memo(RoseChart);
