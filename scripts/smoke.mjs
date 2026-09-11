/**
 * End-to-end smoke test against a running deployment.
 *
 * Verifies the things a build passing does not prove: that the GPU backend
 * initialises, the population actually uploads and renders, a neuron can be
 * picked, and the provenance badge is present.
 *
 *   node scripts/smoke.mjs https://your-deployment.vercel.app
 *
 * Requires playwright (not a project dependency): npm install -D playwright
 */

import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const checks = [];
const record = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

try {
  // bench=1 forces continuous rendering. Without it a still camera legitimately
  // draws nothing, so per-frame counters read 0 and prove nothing either way.
  await page.goto(`${BASE}/brain?dataset=benchmark-200000&debug=1&bench=1`, {
    waitUntil: 'domcontentloaded',
  });

  await page.waitForFunction(
    () => document.querySelector('footer')?.textContent?.includes('READY'),
    { timeout: 120_000 },
  );
  record('reaches READY', true);

  // Stats are emitted on a 400 ms cadence, so the diagnostics panel does not
  // exist the instant the app reports READY. Wait for it rather than racing it.
  await page.waitForSelector('.debug__row', { timeout: 30_000 });
  await page.waitForTimeout(1200);

  const diag = await page.evaluate(() => {
    const rows = {};
    for (const row of document.querySelectorAll('.debug__row')) {
      const k = row.querySelector('span')?.textContent?.trim();
      const v = row.querySelector('b')?.textContent?.trim();
      if (k && v) rows[k] = v;
    }
    return rows;
  });

  record('GPU backend active', Boolean(diag['api']), diag['api'] ?? 'none');
  record(
    'population uploaded',
    parseInt(String(diag['soma total']).replace(/,/g, ''), 10) === 200000,
    `soma total = ${diag['soma total']}`,
  );
  record(
    'GPU buffers allocated',
    parseFloat(diag['gpu buffers']) > 0,
    String(diag['gpu buffers']),
  );
  record(
    'actually drawing',
    parseInt(diag['draw calls'], 10) > 0 && parseFloat(diag['render fps']) > 0,
    `${diag['draw calls']} draw calls, ${diag['render fps']} render fps`,
  );

  // The honesty badge must be present for a synthetic population.
  const badge = await page.textContent('.viewport-badges');
  record('synthetic data badged', /NOT BIOLOGICAL DATA/.test(badge ?? ''), badge?.trim());

  // Pick a neuron by clicking the densest part of the cloud.
  const box = await (await page.$('canvas')).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page
    .waitForFunction(
      () =>
        /Selected neuron \d+/.test(
          document.querySelector('[aria-live="polite"]')?.textContent ?? '',
        ),
      { timeout: 15_000 },
    )
    .catch(() => {});
  const selected = await page.textContent('[aria-live="polite"]');
  record(
    'GPU picking selects a neuron',
    /Selected neuron \d+/.test(selected ?? ''),
    selected?.trim(),
  );

  record('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (e) {
  record('smoke run completed', false, e.message);
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
