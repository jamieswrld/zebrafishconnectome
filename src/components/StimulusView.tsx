'use client';

import { useEffect, useRef } from 'react';
import type { BodyState } from '@/embodiment/types';
import type { VisualMotionEvidence, VisualMotionStimulus } from '@/embodiment/visual-motion';

/**
 * The world, seen from above.
 *
 * Deliberately 2D. A moving coherent-dot field is the stimulus, and a top-down
 * canvas shows the dots, the animal's heading and its path far more legibly
 * than a perspective 3D view would - and it costs a few hundred microseconds
 * instead of a second GPU device, which matters because the brain viewport
 * beside it is already rendering the connectome.
 *
 * Everything drawn here is SIMULATED: the pattern, the tank and the animal.
 */

interface Dot {
  x: number;
  y: number;
  coherent: boolean;
  /** Direction for incoherent dots, radians. */
  angle: number;
}

export function StimulusView({
  stimulus,
  evidence,
  body,
  active,
  trail,
}: {
  stimulus: VisualMotionStimulus;
  evidence: VisualMotionEvidence | null;
  body: BodyState | null;
  active: boolean;
  /** Recent positions in tank millimetres, oldest first. */
  trail: readonly [number, number][];
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dotsRef = useRef<Dot[]>([]);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef(performance.now());

  // The props the draw loop reads, held in a ref so the loop is created once
  // and never torn down on a prop change.
  const stateRef = useRef({ stimulus, evidence, body, active, trail });
  stateRef.current = { stimulus, evidence, body, active, trail };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

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
      rafRef.current = requestAnimationFrame(draw);
      const now = performance.now();
      // Capped at 60 Hz. This is a 2D overview, and on an uncapped display
      // redrawing it at the raw frame rate costs more than the connectome
      // viewport beside it - fillText in particular is expensive.
      if (now - lastRef.current < 1000 / 60) return;
      const dt = Math.min((now - lastRef.current) / 1000, 0.1);
      lastRef.current = now;

      const state = stateRef.current;
      const width = canvas.width;
      const height = canvas.height;
      const scale = Math.min(width, height);

      const styles = getComputedStyle(canvas);
      const ink = styles.getPropertyValue('--text').trim() || '#e8e8e8';
      const dim = styles.getPropertyValue('--text-dim').trim() || '#9a9a9a';
      const border = styles.getPropertyValue('--border').trim() || '#333';
      const viewportBg = styles.getPropertyValue('--viewport-bg').trim() || '#0a0a0b';
      const measured = styles.getPropertyValue('--prov-measured').trim() || '#57b6ff';

      context.fillStyle = viewportBg;
      context.fillRect(0, 0, width, height);

      /* ------------------------------------------------------------- dots */
      const count = Math.max(1, Math.round(state.stimulus.dots));
      if (dotsRef.current.length !== count) {
        dotsRef.current = Array.from({ length: count }, () => ({
          x: Math.random(),
          y: Math.random(),
          coherent: Math.random() < state.stimulus.coherence,
          angle: Math.random() * Math.PI * 2,
        }));
      }

      const signed = state.stimulus.direction === 'right' ? 1 : -1;
      // Pattern speed on screen. Scaled from the stimulus angular speed purely
      // for legibility; the number that drives the circuit is the evidence, not
      // this.
      const patternSpeed = state.active ? signed * state.stimulus.speed * 0.16 : 0;

      context.globalAlpha = state.active ? 1 : 0.25;
      for (const dot of dotsRef.current) {
        if (state.active) {
          if (dot.coherent) {
            dot.x += patternSpeed * dt;
          } else {
            dot.x += Math.cos(dot.angle) * Math.abs(patternSpeed) * dt;
            dot.y += Math.sin(dot.angle) * Math.abs(patternSpeed) * dt;
          }
          if (dot.x > 1) dot.x -= 1;
          if (dot.x < 0) dot.x += 1;
          if (dot.y > 1) dot.y -= 1;
          if (dot.y < 0) dot.y += 1;
        }
        context.fillStyle = dot.coherent ? dim : border;
        const radius = (dot.coherent ? 1.6 : 1.2) * (scale / 500);
        context.beginPath();
        context.arc(dot.x * width, dot.y * height, radius, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;

      /* ------------------------------------------------------------ trail */
      const toScreen = (mm: readonly [number, number]) => {
        // Tank half-extent is about 17.5 mm; map that to the shorter dimension.
        const half = 18;
        return [
          width / 2 + (mm[0] / half) * (scale / 2) * 0.82,
          height / 2 + (mm[1] / half) * (scale / 2) * 0.82,
        ] as const;
      };

      if (state.trail.length > 1) {
        context.strokeStyle = border;
        context.lineWidth = Math.max(1, scale / 600);
        context.beginPath();
        state.trail.forEach((point, index) => {
          const [x, y] = toScreen(point);
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
        context.stroke();
      }

      /* -------------------------------------------------------------- fish */
      if (state.body) {
        const [x, y] = toScreen([state.body.position[0], state.body.position[2]]);
        const heading = state.body.heading;
        const length = scale * 0.075;

        context.save();
        context.translate(x, y);
        context.rotate(heading);

        // Body: a tapered spine that actually bends with the tail phase, so the
        // glyph shows the bout rather than just the position.
        const bend = Math.sin(state.body.pose.tailPhase) * 0.55;
        context.strokeStyle = ink;
        context.lineWidth = Math.max(1.5, scale / 260);
        context.lineCap = 'round';
        context.beginPath();
        context.moveTo(length * 0.45, 0);
        context.quadraticCurveTo(
          -length * 0.1,
          bend * length * 0.18,
          -length * 0.55,
          bend * length * 0.5,
        );
        context.stroke();

        // Head
        context.fillStyle = ink;
        context.beginPath();
        context.ellipse(length * 0.3, 0, length * 0.2, length * 0.13, 0, 0, Math.PI * 2);
        context.fill();
        context.restore();

        // Heading indicator
        context.strokeStyle = measured;
        context.globalAlpha = 0.5;
        context.lineWidth = Math.max(1, scale / 700);
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(
          x + Math.cos(heading) * length * 1.5,
          y + Math.sin(heading) * length * 1.5,
        );
        context.stroke();
        context.globalAlpha = 1;
      }

      /* ----------------------------------------------------------- overlay */
      const pad = scale * 0.03;
      context.font = `${Math.round(scale / 42)}px ui-monospace, monospace`;
      context.fillStyle = dim;
      context.textBaseline = 'top';
      const direction = state.stimulus.direction === 'right' ? '→' : '←';
      context.fillText(
        state.active
          ? `${direction} ${(state.stimulus.coherence * 100).toFixed(0)}% COHERENT`
          : 'NO STIMULUS',
        pad,
        pad,
      );
      if (state.evidence && state.active) {
        const net = state.evidence.rightwardEvidence - state.evidence.leftwardEvidence;
        context.fillText(
          `retinal ${state.evidence.angularVelocity >= 0 ? '+' : ''}${state.evidence.angularVelocity.toFixed(2)} rad/s`,
          pad,
          pad + scale / 32,
        );
        // A small signed bar for the instantaneous evidence.
        const barWidth = scale * 0.22;
        const barY = pad + scale / 18;
        context.strokeStyle = border;
        context.strokeRect(pad, barY, barWidth, scale / 90);
        context.fillStyle = measured;
        context.fillRect(pad + barWidth / 2, barY, (net * barWidth) / 2, scale / 90);
      }
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      observer.disconnect();
    };
  }, []);

  return (
    <div className="stimulus-view">
      <canvas ref={canvasRef} aria-label="Simulated visual motion stimulus and fish position" />
      <span className="viewport-badges">
        <span className="badge badge--warn">STIMULUS SIMULATED</span>
      </span>
    </div>
  );
}
