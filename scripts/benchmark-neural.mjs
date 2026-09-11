/**
 * Phase 3 benchmark: what does running a connectome-constrained model cost?
 *
 *   node scripts/benchmark-neural.mjs --url http://localhost:3211
 *
 * Measures the same populations with and without the neural runtime so the
 * delta is the model, not the scene. Every number comes from the application's
 * own diagnostics panel.
 *
 * Requires playwright (not a project dependency): npm install -D playwright
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const urlArg = args.indexOf('--url');
const BASE = urlArg >= 0 ? args[urlArg + 1] : 'http://localhost:3000';
const MEASURE_SECONDS = 8;

/**
 * `/brain` scenarios are the Phase 1/2 baselines, re-measured here so a Phase 3
 * regression would be visible rather than assumed away.
 */
const SCENARIOS = [
  { key: 'brain-200k', label: '200k soma', path: 'brain', query: 'dataset=benchmark-200000' },
  {
    key: 'organism-200k',
    label: '200k soma + body',
    path: 'brain',
    query: 'dataset=benchmark-200000&view=organism',
  },
  { key: 'brain-fish1', label: 'fish1 30k', path: 'brain', query: 'dataset=fish1-released' },
  {
    key: 'organism-fish1',
    label: 'fish1 + body',
    path: 'brain',
    query: 'dataset=fish1-released&view=organism',
  },
  {
    key: 'neural-fish1-idle',
    label: 'fish1 + neural idle',
    path: 'experiments/visual-motion',
    query: 'dataset=fish1-released',
    idle: true,
  },
  {
    key: 'neural-fish1-active',
    label: 'fish1 + neural active',
    path: 'experiments/visual-motion',
    query: 'dataset=fish1-released',
  },
  {
    key: 'neural-200k-idle',
    label: '200k + neural idle',
    path: 'experiments/visual-motion',
    query: 'dataset=benchmark-200000',
    idle: true,
  },
  {
    key: 'neural-200k-active',
    label: '200k + neural active',
    path: 'experiments/visual-motion',
    query: 'dataset=benchmark-200000',
  },
];

/** Orbits from inside the page; driving the mouse over CDP caps the event rate. */
async function startOrbit(page) {
  await page.evaluate(() => {
    const canvas = document.querySelectorAll('canvas');
    const target = canvas[canvas.length - 1];
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const opts = { pointerId: 1, pointerType: 'mouse', bubbles: true, isPrimary: true };
    target.dispatchEvent(
      new PointerEvent('pointerdown', { ...opts, clientX: cx, clientY: cy, button: 0, buttons: 1 }),
    );
    window.__benchStop = false;
    let a = 0;
    const tick = () => {
      if (window.__benchStop) return;
      a += 0.03;
      target.dispatchEvent(
        new PointerEvent('pointermove', {
          ...opts,
          clientX: cx + Math.cos(a) * 200,
          clientY: cy + Math.sin(a) * 110,
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
    const canvas = document.querySelectorAll('canvas');
    canvas[canvas.length - 1]?.dispatchEvent(
      new PointerEvent('pointerup', { pointerId: 1, bubbles: true }),
    );
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
      neuralMs: num(rows['neural step']),
      simMs: num(rows['sim update']),
      activityUpload: num(rows['activity upload']),
      hmiNodes: num(rows['hmi nodes']),
      somaTotal: rows['soma total'],
      gpuBuffers: rows['gpu buffers'],
      api: rows['api'],
      device: panel.lastElementChild?.textContent?.trim(),
    };
  });
}

const median = (sorted) => {
  if (sorted.length === 0) return NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,WebGPU',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    // Uncapped: with vsync on every scenario reports 60 and the benchmark
    // measures the display rather than the renderer.
    '--disable-frame-rate-limit',
    '--disable-gpu-vsync',
  ],
});

const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('  page error:', e.message));

const results = [];

for (const scenario of SCENARIOS) {
  process.stdout.write(`\n${scenario.label.padEnd(24)} ... `);
  // Both idle and active use continuous rendering, so the comparison is of
  // throughput and not of the idle-frame-skipping path.
  const bench = scenario.idle ? '&bench=1&idle=1' : '&bench=1';
  await page.goto(`${BASE}/${scenario.path}?${scenario.query}&debug=1${bench}`, {
    waitUntil: 'domcontentloaded',
  });

  try {
    if (scenario.path === 'brain') {
      await page.goto(`${BASE}/${scenario.path}?${scenario.query}&debug=1&bench=1`, {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForFunction(
        () => document.querySelector('footer')?.textContent?.includes('READY'),
        { timeout: 240_000 },
      );
    } else {
      await page.waitForSelector('.bilateral', { timeout: 240_000 });

    }
    await page.waitForSelector('.debug__row', { timeout: 60_000 });
  } catch {
    console.log('never became ready');
    results.push({ ...scenario, error: 'not ready' });
    continue;
  }

  await page.waitForTimeout(3500);
  await startOrbit(page);

  const samples = [];
  const started = Date.now();
  while (Date.now() - started < MEASURE_SECONDS * 1000) {
    await new Promise((r) => setTimeout(r, 250));
    if (Date.now() - started > 1500) {
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

  const pick = (key) =>
    samples
      .map((s) => s[key])
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
  const last = samples.at(-1);

  const entry = {
    key: scenario.key,
    label: scenario.label,
    renderFpsMedian: median(pick('renderFps')),
    cpuFrameMsMedian: median(pick('cpuMs')),
    neuralMsMedian: median(pick('neuralMs')),
    simMsMedian: median(pick('simMs')),
    drawCalls: last.drawCalls,
    meshTriangles: last.meshTriangles,
    activityUpload: last.activityUpload,
    hmiNodes: last.hmiNodes,
    somaTotal: last.somaTotal,
    gpuBuffers: last.gpuBuffers,
    api: last.api,
    device: last.device,
    samples: samples.length,
  };
  results.push(entry);
  console.log(
    `${entry.renderFpsMedian.toFixed(1)} fps, cpu ${entry.cpuFrameMsMedian.toFixed(2)} ms, ` +
      `neural ${Number.isFinite(entry.neuralMsMedian) ? entry.neuralMsMedian.toFixed(3) : '—'} ms, ` +
      `${entry.drawCalls} draws`,
  );
}

await browser.close();

const device = results.find((r) => r.device)?.device ?? 'unknown';
writeFileSync(
  'benchmark-neural.json',
  JSON.stringify({ generatedAt: new Date().toISOString(), device, results }, null, 2),
);

console.log('\n' + '='.repeat(102));
console.log(`device: ${device}`);
console.log('='.repeat(102));
console.log(
  'scenario'.padEnd(24) +
    'fps'.padEnd(10) +
    'cpu ms'.padEnd(10) +
    'neural ms'.padEnd(12) +
    'sim ms'.padEnd(10) +
    'draws'.padEnd(8) +
    'upload'.padEnd(10) +
    'gpu buffers',
);
for (const r of results) {
  if (r.error) {
    console.log(`${r.label.padEnd(24)}${r.error}`);
    continue;
  }
  const n = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  console.log(
    r.label.padEnd(24) +
      n(r.renderFpsMedian, 1).padEnd(10) +
      n(r.cpuFrameMsMedian).padEnd(10) +
      n(r.neuralMsMedian, 3).padEnd(12) +
      n(r.simMsMedian, 3).padEnd(10) +
      String(r.drawCalls).padEnd(8) +
      String(r.activityUpload ?? '—').padEnd(10) +
      String(r.gpuBuffers),
  );
}

const pair = (a, b, note) => {
  const x = results.find((r) => r.key === a);
  const y = results.find((r) => r.key === b);
  if (!x || !y || x.error || y.error) return;
  const delta = ((y.renderFpsMedian - x.renderFpsMedian) / x.renderFpsMedian) * 100;
  console.log(
    `\n${note}: ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% render fps ` +
      `(${x.renderFpsMedian.toFixed(0)} -> ${y.renderFpsMedian.toFixed(0)})`,
  );
};
pair('brain-200k', 'organism-200k', '200k: body cost');
pair('neural-fish1-idle', 'neural-fish1-active', 'fish1: idle -> active simulation');
pair('neural-200k-idle', 'neural-200k-active', '200k: idle -> active simulation');
pair('brain-fish1', 'neural-fish1-active', 'fish1: viewer -> full closed loop');
pair('brain-200k', 'neural-200k-active', '200k: viewer -> full closed loop');

console.log('\nwrote benchmark-neural.json');
