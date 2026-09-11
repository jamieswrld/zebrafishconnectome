/**
 * Renderer benchmark harness.
 *
 * Drives the real application in a real browser against the deterministic
 * synthetic populations, orbits the camera to force continuous redraws, and
 * reads the measured FPS and frame time out of the diagnostics panel.
 *
 * Everything reported comes from the application's own instrumentation. The
 * harness measures; it does not estimate.
 *
 *   node scripts/benchmark.mjs [--url http://localhost:3000] [--headed]
 *
 * Note on validity: launched against the installed Chrome with GPU enabled, so
 * numbers reflect real hardware rasterisation. A software (SwiftShader) run is
 * detected and labelled, because those figures say nothing about real use.
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const urlArg = args.indexOf('--url');
const BASE = urlArg >= 0 ? args[urlArg + 1] : 'http://localhost:3000';
const HEADED = args.includes('--headed');

const SIZES = [10_000, 50_000, 100_000, 200_000, 500_000];
/** Seconds of continuous camera motion to average over, per size. */
const MEASURE_SECONDS = 6;

async function main() {
  const browser = await chromium.launch({
    // Real Chrome, not bundled Chromium: we want the actual GPU stack.
    channel: 'chrome',
    headless: !HEADED,
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,WebGPU',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--use-angle=default',
      // Uncap the frame rate. With vsync on, every population size reports
      // exactly 60 fps and the benchmark measures the display instead of the
      // renderer, hiding all remaining headroom.
      '--disable-frame-rate-limit',
      '--disable-gpu-vsync',
    ],
  });

  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => console.error('  page error:', e.message));

  const results = [];

  for (const size of SIZES) {
    const url = `${BASE}/brain?dataset=benchmark-${size}&debug=1&bench=1`;
    process.stdout.write(`\n${size.toLocaleString()} soma ... `);

    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Wait for the application to report READY, not for a fixed timeout.
    try {
      await page.waitForFunction(
        () => document.querySelector('footer')?.textContent?.includes('READY'),
        { timeout: 180_000 },
      );
    } catch {
      console.log('did not reach READY');
      results.push({ size, error: 'never reached READY' });
      continue;
    }
    const loadMs = Date.now() - t0;

    // Orbit from INSIDE the page.
    //
    // Driving the mouse over CDP caps input at a few dozen events per second,
    // and because the renderer skips idle frames, the reported FPS then tracks
    // the event rate rather than render throughput. An in-page rAF loop emits
    // one pointermove per animation frame, so every frame is a genuine redraw
    // and the measurement reflects the renderer.
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const opts = { pointerId: 1, pointerType: 'mouse', bubbles: true, isPrimary: true };
      canvas.dispatchEvent(
        new PointerEvent('pointerdown', {
          ...opts,
          clientX: cx,
          clientY: cy,
          button: 0,
          buttons: 1,
        }),
      );
      window.__benchStop = false;
      let a = 0;
      const tick = () => {
        if (window.__benchStop) return;
        a += 0.03;
        canvas.dispatchEvent(
          new PointerEvent('pointermove', {
            ...opts,
            clientX: cx + Math.cos(a) * 240,
            clientY: cy + Math.sin(a) * 130,
            buttons: 1,
          }),
        );
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const samples = [];
    const started = Date.now();
    while (Date.now() - started < MEASURE_SECONDS * 1000) {
      await new Promise((r) => setTimeout(r, 250));
      // Discard the first second: buffer upload and shader warm-up are not
      // steady-state rendering.
      if (Date.now() - started > 1000) {
        const row = await readDiagnostics(page);
        if (row) samples.push(row);
      }
    }
    await page.evaluate(() => {
      window.__benchStop = true;
      document
        .querySelector('canvas')
        .dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    });

    if (samples.length === 0) {
      results.push({ size, loadMs, error: 'no diagnostics samples' });
      console.log('no samples');
      continue;
    }

    // Quote RENDER throughput, not the rAF tick rate.
    const fps = samples
      .map((s) => s.renderFps)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const rafFps = samples
      .map((s) => s.fps)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const cpu = samples
      .map((s) => s.cpuMs)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

    const result = {
      size,
      loadMs,
      samples: samples.length,
      renderFpsMedian: median(fps),
      rafFpsMedian: median(rafFps),
      fpsMedian: median(fps),
      fpsMin: fps[0],
      fpsMax: fps.at(-1),
      cpuFrameMsMedian: median(cpu),
      cpuFrameMsMax: cpu.at(-1),
      drawCalls: samples.at(-1).drawCalls,
      gpuBuffers: samples.at(-1).gpuBuffers,
      cpuIndex: samples.at(-1).cpuIndex,
      filterMs: samples.at(-1).filterMs,
      api: samples.at(-1).api,
      device: samples.at(-1).device,
    };
    results.push(result);
    console.log(
      `${result.fpsMedian.toFixed(1)} fps median (${result.fpsMin.toFixed(1)}-${result.fpsMax.toFixed(1)}), ` +
        `${result.cpuFrameMsMedian.toFixed(2)} ms cpu, ${result.drawCalls} draw calls, load ${loadMs} ms`,
    );
  }

  await browser.close();

  const device = results.find((r) => r.device)?.device ?? 'unknown';
  const api = results.find((r) => r.api)?.api ?? 'unknown';
  const software = /swiftshader|llvmpipe|software/i.test(device);

  const report = {
    generatedAt: new Date().toISOString(),
    device,
    api,
    softwareRasterizer: software,
    viewport: '1600x900',
    measureSeconds: MEASURE_SECONDS,
    note: software
      ? 'SOFTWARE RASTERIZER: these numbers do not represent real GPU hardware.'
      : 'Hardware GPU rasterisation.',
    results,
  };

  writeFileSync('benchmark-results.json', JSON.stringify(report, null, 2));

  console.log('\n' + '='.repeat(78));
  console.log(`device : ${device}`);
  console.log(`api    : ${api}${software ? '  [SOFTWARE RASTERIZER]' : ''}`);
  console.log('='.repeat(78));
  console.log(
    'soma'.padEnd(10) +
      'fps med'.padEnd(10) +
      'fps min'.padEnd(10) +
      'cpu ms'.padEnd(9) +
      'draws'.padEnd(7) +
      'gpu buf'.padEnd(11) +
      'load ms',
  );
  for (const r of results) {
    if (r.error) {
      console.log(`${r.size.toLocaleString().padEnd(10)}${r.error}`);
      continue;
    }
    console.log(
      r.size.toLocaleString().padEnd(10) +
        r.fpsMedian.toFixed(1).padEnd(10) +
        r.fpsMin.toFixed(1).padEnd(10) +
        r.cpuFrameMsMedian.toFixed(2).padEnd(9) +
        String(r.drawCalls).padEnd(7) +
        String(r.gpuBuffers).padEnd(11) +
        String(r.loadMs),
    );
  }
  console.log('\nwrote benchmark-results.json');
}

/** Scrapes the diagnostics panel, which renders the app's measured values. */
async function readDiagnostics(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.debug');
    if (!panel) return null;
    const rows = {};
    for (const row of panel.querySelectorAll('.debug__row')) {
      const key = row.querySelector('span')?.textContent?.trim();
      const value = row.querySelector('b')?.textContent?.trim();
      if (key && value) rows[key] = value;
    }
    const num = (s) => (s ? parseFloat(s) : NaN);
    return {
      fps: num(rows['fps (raf)']),
      renderFps: num(rows['render fps']),
      cpuMs: num(rows['cpu frame']),
      drawCalls: num(rows['draw calls']),
      gpuBuffers: rows['gpu buffers'],
      cpuIndex: rows['cpu index'],
      filterMs: rows['filter pass'],
      api: rows['api'],
      device: panel.lastElementChild?.textContent?.trim(),
    };
  });
}

function median(sorted) {
  if (sorted.length === 0) return NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
