'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExperimentTrace } from '@/neural/trace';

/**
 * The experiment timeline.
 *
 * Reads directly from the bounded trace buffers, so scrubbing a finished run
 * never re-runs the neural model: the state was recorded when it happened and
 * the timeline is a view of it.
 *
 * Drawn on a canvas rather than as SVG because a 3,000-sample trace across six
 * tracks is thousands of DOM nodes otherwise, updated every frame.
 */

interface TrackSpec {
  readonly key: Parameters<ExperimentTrace['track']>[0];
  readonly label: string;
  readonly color: string;
  /** Tracks sharing a row are drawn together. */
  readonly row: number;
  /** Value range for the row. */
  readonly range: readonly [number, number];
}

const TRACKS: readonly TrackSpec[] = [
  { key: 'stimulus', label: 'STIMULUS', color: '--text-dim', row: 0, range: [-1, 1] },
  {
    key: 'classILeft',
    label: 'CLASS I L',
    color: '--cell-excitatory',
    row: 1,
    range: [0, 0.6],
  },
  { key: 'classIRight', label: 'CLASS I R', color: '--prov-measured', row: 1, range: [0, 0.6] },
  {
    key: 'classIILeft',
    label: 'CLASS II L',
    color: '--cell-inhibitory',
    row: 2,
    range: [0, 0.4],
  },
  {
    key: 'classIIRight',
    label: 'CLASS II R',
    color: '--prov-predicted',
    row: 2,
    range: [0, 0.4],
  },
  { key: 'readoutLeft', label: 'SPN L', color: '--cell-excitatory', row: 3, range: [0, 0.6] },
  { key: 'readoutRight', label: 'SPN R', color: '--prov-measured', row: 3, range: [0, 0.6] },
  {
    key: 'decisionVariable',
    label: 'DECISION',
    color: '--selected',
    row: 4,
    range: [-0.4, 0.4],
  },
  {
    key: 'bodyYaw',
    label: 'BODY YAW',
    color: '--text-dim',
    row: 5,
    range: [-Math.PI, Math.PI],
  },
];

const ROW_LABELS = ['STIMULUS', 'CLASS I', 'CLASS II', 'SPN TURNING', 'DECISION', 'BODY YAW'];
const ROWS = ROW_LABELS.length;

export function DecisionTimeline({
  trace,
  threshold,
  currentTime,
  onScrub,
}: {
  trace: ExperimentTrace;
  threshold: number;
  currentTime: number;
  /** Called with a time when the user scrubs, or null when they release. */
  onScrub: (time: number | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const stateRef = useRef({ trace, threshold, currentTime, scrubTime });
  stateRef.current = { trace, threshold, currentTime, scrubTime };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    let raf = 0;

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const state = stateRef.current;
      const width = canvas.width;
      const height = canvas.height;
      const styles = getComputedStyle(canvas);
      const token = (name: string, fallback: string) =>
        styles.getPropertyValue(name).trim() || fallback;

      context.clearRect(0, 0, width, height);

      const count = state.trace.length();
      const labelWidth = Math.min(86, width * 0.16);
      const plotLeft = labelWidth;
      const plotWidth = Math.max(1, width - plotLeft - 6);
      const rowHeight = height / ROWS;
      const border = token('--border', '#2a2a2a');

      const times = state.trace.track('time');
      const tMax = count > 0 ? Math.max(times[count - 1], 1) : 1;

      context.font = `${Math.max(8, Math.round(height / 34))}px ui-monospace, monospace`;
      context.textBaseline = 'middle';

      for (let row = 0; row < ROWS; row++) {
        const top = row * rowHeight;
        context.strokeStyle = border;
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(0, top);
        context.lineTo(width, top);
        context.stroke();

        context.fillStyle = token('--text-faint', '#777');
        context.fillText(ROW_LABELS[row], 6, top + rowHeight / 2);

        // Zero line for signed rows.
        if (row === 0 || row === 4 || row === 5) {
          context.strokeStyle = border;
          context.globalAlpha = 0.6;
          context.beginPath();
          context.moveTo(plotLeft, top + rowHeight / 2);
          context.lineTo(width - 6, top + rowHeight / 2);
          context.stroke();
          context.globalAlpha = 1;
        }
      }

      // Decision threshold guides on the decision row.
      const decisionTop = 4 * rowHeight;
      const decisionRange = 0.4;
      context.strokeStyle = token('--warn', '#d0a030');
      context.globalAlpha = 0.5;
      context.setLineDash([3, 3]);
      for (const sign of [-1, 1]) {
        const y =
          decisionTop +
          rowHeight -
          ((sign * state.threshold + decisionRange) / (decisionRange * 2)) * rowHeight;
        context.beginPath();
        context.moveTo(plotLeft, y);
        context.lineTo(width - 6, y);
        context.stroke();
      }
      context.setLineDash([]);
      context.globalAlpha = 1;

      if (count > 1) {
        for (const track of TRACKS) {
          const values = state.trace.track(track.key);
          const [low, high] = track.range;
          const top = track.row * rowHeight;
          context.strokeStyle = token(track.color, '#888');
          context.lineWidth = Math.max(1, height / 260);
          context.beginPath();
          // Stride so a long trace never draws more segments than there are
          // pixels to show them in.
          const stride = Math.max(1, Math.floor(count / plotWidth));
          for (let i = 0; i < count; i += stride) {
            const x = plotLeft + (times[i] / tMax) * plotWidth;
            const normalised = (values[i] - low) / (high - low);
            const y = top + rowHeight - Math.min(Math.max(normalised, 0), 1) * rowHeight;
            if (i === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
          }
          context.stroke();
        }

        // Decision marks span every row, so the causal order is visible: the
        // decision is drawn where it happened relative to the body turning.
        for (const mark of state.trace.decisions()) {
          const x = plotLeft + (mark.time / tMax) * plotWidth;
          context.strokeStyle = token('--selected', '#e0a030');
          context.globalAlpha = 0.85;
          context.lineWidth = Math.max(1, height / 300);
          context.beginPath();
          context.moveTo(x, 0);
          context.lineTo(x, height);
          context.stroke();
          context.globalAlpha = 1;
          context.fillStyle = token('--selected', '#e0a030');
          context.fillText(mark.action === 'turn_right' ? '▶' : '◀', x + 3, 8);
        }
      }

      // Playhead.
      const head = state.scrubTime ?? state.currentTime;
      if (count > 0) {
        const x = plotLeft + (Math.min(head, tMax) / tMax) * plotWidth;
        context.strokeStyle = token('--text', '#eee');
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
      }
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  const timeAt = useCallback(
    (clientX: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return 0;
      const rect = canvas.getBoundingClientRect();
      const labelWidth = Math.min(86, rect.width * 0.16);
      const plotWidth = Math.max(1, rect.width - labelWidth - 6);
      const fraction = (clientX - rect.left - labelWidth) / plotWidth;
      const count = trace.length();
      const times = trace.track('time');
      const tMax = count > 0 ? times[count - 1] : 0;
      return Math.min(Math.max(fraction, 0), 1) * tMax;
    },
    [trace],
  );

  return (
    <div className="timeline">
      <canvas
        ref={canvasRef}
        aria-label="Experiment timeline"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          const time = timeAt(event.clientX);
          setScrubTime(time);
          onScrub(time);
        }}
        onPointerMove={(event) => {
          if (scrubTime === null) return;
          const time = timeAt(event.clientX);
          setScrubTime(time);
          onScrub(time);
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          setScrubTime(null);
          onScrub(null);
        }}
      />
      <div className="timeline__foot">
        <span className="faint">
          {trace.length()} samples at 50 Hz{trace.isFull() ? ' (buffer full)' : ''}
        </span>
        <span className="faint">
          {scrubTime !== null
            ? `scrubbing ${scrubTime.toFixed(2)} s — recorded state, not a re-run`
            : 'drag to scrub'}
        </span>
      </div>
    </div>
  );
}
