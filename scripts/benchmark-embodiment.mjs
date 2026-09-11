/**
 * Embodiment cost benchmark.
 *
 * Answers the question Phase 2 has to answer: what does putting the connectome
 * in a body actually cost? It measures the same population with and without the
 * body, so the delta is the body, not the scene.
 *
 *   node scripts/benchmark-embodiment.mjs --url http://localhost:3111
 *
 * Every number comes from the application's own diagnostics panel. Requires
 * playwright (not a project dependency): npm install -D playwright
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const urlArg = args.indexOf('--url');
const BASE = urlArg >= 0 ? args[urlArg + 1] : 'http://localhost:3000';
const MEASURE_SECONDS = 6;

const SCENARIOS = [
  { key: 'brain-200k', label: '200k soma', query: 'dataset=benchmark-200000' },
  {
    key: 'organism-200k',
    label: '200k soma + body',
    query: 'dataset=benchmark-200000&view=organism',
  },
  { key: 'brain-fish1', label: 'fish1 released', query: 'dataset=fish1-released' },
  {
    key: 'organism-fish1',
    label: 'fish1 + body',
    query: 'dataset=fish1-released&view=organism',
  },
];

/**
 * Orbits from inside the page: driving the mouse over CDP caps input at a few
 * dozen events per second, and because the renderer skips idle frames the
 * reported FPS would track the event rate rather than render throughput.
 */
async function startOrbit(page) {
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
}

async function stopOrbit(page) {
  await page.evaluate(() => {
    window.__benchStop = true;
    document
      .querySelector('canvas')
      ?.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
  });
}

async function readDiagnostics(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.debug');
    if (!panel) return null;
    const rows = {};
    for (const row of panel.querySelectorAll('.debug__row')) {
      const k = row.querySelector('span')?.textContent?.trim();
      const v = row.querySelector('b')?.textContent?.trim();
      if (k && v) rows[k] = v;
    }
    const num = (s) => (s ? parseFloat(s.replace(/,/g, '')) : NaN);
    return {
      renderFps: num(rows['render fps']),
      cpuMs: num(rows['cpu frame']),
      drawCalls: num(rows['draw calls']),
      meshTriangles: num(rows['mesh triangles']),
      somaTotal: rows['soma total'],
      gpuBuffers: rows['gpu buffers'],
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

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,WebGPU',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    // Uncapped: with vsync on, every scenario reports 60 and the benchmark
    // measures the display rather than the renderer.
    '--disable-frame-rate-limit',
    '--disable-gpu-vsync',
  ],
});

const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('  page error:', e.message));

const results = [];

for (const scenario of SCENARIOS) {
  process.stdout.write(`\n${scenario.label} ... `);
  await page.goto(`${BASE}/brain?${scenario.query}&debug=1&bench=1`, {
    waitUntil: 'domcontentloaded',
  });

  try {
    await page.waitForFunction(
      () => document.querySelector('footer')?.textContent?.includes('READY'),
      { timeout: 180_000 },
    );
    await page.waitForSelector('.debug__row', { timeout: 30_000 });
  } catch {
    console.log('never became ready');
    results.push({ ...scenario, error: 'not ready' });
    continue;
  }

  // The body asset loads after READY; let it arrive and settle before sampling.
  await page.waitForTimeout(3000);
  await startOrbit(page);

  const samples = [];
  const started = Date.now();
  while (Date.now() - started < MEASURE_SECONDS * 1000) {
    await new Promise((r) => setTimeout(r, 250));
    if (Date.now() - started > 1000) {
      const row = await readDiagnostics(page);
      if (row) samples.push(row);
    }
  }
  await stopOrbit(page);

  if (samples.length === 0) {
    results.push({ ...scenario, error: 'no samples' });
    console.log('no samples');
    continue;
  }

  const fps = samples
    .map((s) => s.renderFps)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const cpu = samples
    .map((s) => s.cpuMs)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const last = samples.at(-1);

  const entry = {
    key: scenario.key,
    label: scenario.label,
    renderFpsMedian: median(fps),
    renderFpsMin: fps[0],
    cpuFrameMsMedian: median(cpu),
    drawCalls: last.drawCalls,
    meshTriangles: last.meshTriangles,
    somaTotal: last.somaTotal,
    gpuBuffers: last.gpuBuffers,
    api: last.api,
    device: last.device,
    samples: samples.length,
  };
  results.push(entry);
  console.log(
    `${entry.renderFpsMedian.toFixed(1)} fps, ${entry.cpuFrameMsMedian.toFixed(2)} ms cpu, ` +
      `${entry.drawCalls} draws, ${entry.meshTriangles} mesh tris`,
  );
}

await browser.close();

const device = results.find((r) => r.device)?.device ?? 'unknown';
writeFileSync(
  'benchmark-embodiment.json',
  JSON.stringify({ generatedAt: new Date().toISOString(), device, results }, null, 2),
);

console.log('\n' + '='.repeat(80));
console.log(`device: ${device}`);
console.log('='.repeat(80));
console.log(
  'scenario'.padEnd(20) +
    'fps med'.padEnd(11) +
    'cpu ms'.padEnd(10) +
    'draws'.padEnd(8) +
    'mesh tris'.padEnd(12) +
    'gpu buffers',
);
for (const r of results) {
  if (r.error) {
    console.log(`${r.label.padEnd(20)}${r.error}`);
    continue;
  }
  console.log(
    r.label.padEnd(20) +
      r.renderFpsMedian.toFixed(1).padEnd(11) +
      r.cpuFrameMsMedian.toFixed(2).padEnd(10) +
      String(r.drawCalls).padEnd(8) +
      String(r.meshTriangles).padEnd(12) +
      String(r.gpuBuffers),
  );
}

// The headline number: what embodiment costs on an identical population.
const pair = (a, b) => {
  const x = results.find((r) => r.key === a);
  const y = results.find((r) => r.key === b);
  if (!x || !y || x.error || y.error) return;
  const delta = ((y.renderFpsMedian - x.renderFpsMedian) / x.renderFpsMedian) * 100;
  console.log(
    `\n${x.label} -> ${y.label}: ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% render fps, ` +
      `cpu ${x.cpuFrameMsMedian.toFixed(2)} -> ${y.cpuFrameMsMedian.toFixed(2)} ms`,
  );
};
pair('brain-200k', 'organism-200k');
pair('brain-fish1', 'organism-fish1');

console.log('\nwrote benchmark-embodiment.json');
