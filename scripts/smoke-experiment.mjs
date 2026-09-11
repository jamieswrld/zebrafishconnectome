/**
 * End-to-end check of the visual motion decision experiment.
 *
 * Proves in a real browser what unit tests cannot: that the circuit artefact
 * loads over HTTP, the GPU backend initialises, the model runs, a decision is
 * actually reached, and the body turns because of it.
 *
 *   node scripts/smoke-experiment.mjs http://localhost:3211
 *
 * Requires playwright (not a project dependency): npm install -D playwright
 */

import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const FORCE_WEBGL = process.argv.includes('--webgl2');

const checks = [];
const record = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const args = ['--ignore-gpu-blocklist'];
if (FORCE_WEBGL) args.push('--disable-features=WebGPU');
else args.push('--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU');

const browser = await chromium.launch({ channel: 'chrome', headless: true, args });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

/** Reads the readout strip into a plain object. */
const readReadout = () =>
  page.evaluate(() => {
    const out = {};
    for (const block of document.querySelectorAll('.experiment__readout .hud__block')) {
      const label = block.querySelector('.hud__label')?.textContent?.trim();
      const value = block.querySelector('.hud__value')?.textContent?.trim();
      const sub = block.querySelector('.hud__sub')?.textContent?.trim();
      if (label) out[label] = { value, sub };
    }
    return out;
  });

try {
  console.log(`\n${FORCE_WEBGL ? 'WebGL2' : 'WebGPU'}  ${BASE}\n`);

  await page.goto(`${BASE}/experiments/visual-motion?direction=right&coherence=1&seed=42&loop=open`, {
    waitUntil: 'domcontentloaded',
  });

  // The circuit panel only renders once the measured artefact has decoded.
  await page.waitForSelector('.bilateral', { timeout: 120_000 });
  record('HMI circuit artefact loads and decodes', true);

  const coupling = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.kv dt')];
    const out = {};
    for (const dt of rows) out[dt.textContent.trim()] = dt.nextElementSibling?.textContent?.trim();
    return out;
  });
  record(
    'declares measured connectivity and simulated activity',
    coupling['Connectivity']?.startsWith('MEASURED') && coupling['Neural activity'] === 'SIMULATED',
    `${coupling['Connectivity']} / ${coupling['Neural activity']}`,
  );
  record(
    'declares the motor plant as procedural',
    coupling['Motor plant'] === 'PROCEDURAL',
    coupling['Motor plant'],
  );

  const networkRows = await page.evaluate(() => {
    const out = {};
    for (const dt of document.querySelectorAll('.kv dt')) {
      out[dt.textContent.trim()] = dt.nextElementSibling?.textContent?.trim();
    }
    return out;
  });
  record(
    'mirror cells are labelled derived, not measured',
    /derived/i.test(networkRows['Mirror cells'] ?? ''),
    networkRows['Mirror cells'],
  );
  record(
    'HMI cells are located in the loaded structural dataset',
    parseInt((networkRows['Drawn on brain'] ?? '0').replace(/[^0-9]/g, ''), 10) > 500,
    networkRows['Drawn on brain'],
  );

  // --- run the experiment -------------------------------------------------
  await page.click('button:has-text("START")');
  await page.waitForTimeout(6000);

  const readout = await readReadout();
  record(
    'evidence is produced by the stimulus',
    readout['Evidence']?.value && !readout['Evidence'].value.includes('0.00 · R 0.00'),
    readout['Evidence']?.value,
  );
  record(
    'the circuit reaches a decision',
    readout['Decision']?.value === 'RIGHT',
    `${readout['Decision']?.value} (${readout['Decision']?.sub})`,
  );
  record(
    'the decision produces a motor action',
    readout['Action']?.value === 'TURN RIGHT',
    `${readout['Action']?.value} ${readout['Action']?.sub ?? ''}`,
  );
  record(
    'the action is attributed to the connectome',
    readout['Source']?.value === 'CONNECTOME',
    readout['Source']?.value,
  );

  const stepMs = parseFloat(readout['Neural step']?.value ?? 'NaN');
  record('neural step time is reported and small', stepMs >= 0 && stepMs < 6, `${stepMs} ms`);

  // The body must actually have moved.
  const swum = await page.evaluate(() => {
    const heads = [...document.querySelectorAll('.experiment__view-head')];
    return heads[0]?.querySelector('.num')?.textContent?.trim();
  });
  record('the body swam', parseFloat(swum ?? '0') > 0, swum);

  // Traces must have been recorded for the timeline.
  const traceText = await page.textContent('.timeline__foot');
  // The trace samples at min(50 Hz, frame rate); headless Chrome throttles rAF,
  // so the bar is "samples were recorded", not a specific rate.
  const samples = parseInt(traceText?.match(/(\d+) samples/)?.[1] ?? '0', 10);
  record('timeline recorded trace samples', samples > 20, `${samples} samples`);

  // --- reproducibility ----------------------------------------------------
  const runOnce = async () => {
    await page.click('button:has-text("RESET")');
    await page.waitForTimeout(300);
    await page.click('button:has-text("START")');
    await page.waitForTimeout(5000);
    const r = await readReadout();
    return r['Action']?.sub ?? '';
  };
  const first = await runOnce();
  const second = await runOnce();
  record('same seed reproduces the same latency', first === second && first !== '', `${first} vs ${second}`);

  // --- ablation -----------------------------------------------------------
  await page.click('button:has-text("RESET")');
  await page.click('button:has-text("ABLATE · Class I ipsilateral recurrence")');
  await page.click('button:has-text("START")');
  await page.waitForTimeout(6000);
  const ablated = await readReadout();
  record(
    'ablating the measured recurrence abolishes the decision',
    ablated['Action']?.value === 'NONE',
    ablated['Action']?.value,
  );

  // --- controller switching ----------------------------------------------
  await page.click('button:has-text("RESTORE · Class I ipsilateral recurrence")');
  await page.click('button:has-text("BASELINE")');
  await page.waitForTimeout(1200);
  const baseline = await readReadout();
  record(
    'switching to the baseline controller turns coupling off',
    baseline['Source']?.value === 'PROCEDURAL',
    baseline['Source']?.value,
  );

  // --- view modes ---------------------------------------------------------
  for (const label of ['HMI ONLY', 'ACTIVE', 'INPUT', 'OUTPUT', 'ALL BRAIN']) {
    await page.click(`button:has-text("${label}")`);
    await page.waitForTimeout(200);
  }
  record('every brain view mode renders without error', pageErrors.length === 0);

  // --- signal flow --------------------------------------------------------
  await page.click('button:has-text("NEURAL HMI")');
  await page.click('button:has-text("START")');
  await page.waitForTimeout(3000);
  await page.click('button:has-text("SIGNAL FLOW")');
  await page.waitForTimeout(2500);
  // The stimulus view has its own badge strip; read the brain viewport's.
  const flowBadge = await page.textContent('.viewport-wrap .viewport-badges');
  record(
    'signal flow is badged as simulated propagation',
    /SIMULATED PROPAGATION/.test(flowBadge ?? ''),
  );
  await page.click('button:has-text("SIGNAL FLOW")');
  await page.waitForTimeout(500);
  record('signal flow toggles off cleanly', pageErrors.length === 0);

  record('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
} catch (e) {
  record('experiment smoke test completed', false, e.message);
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
