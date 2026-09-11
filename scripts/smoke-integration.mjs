import { chromium } from 'playwright';
const BASE = process.argv[2] ?? 'http://localhost:3211';
const checks = [];
const rec = (n, ok, d='') => { checks.push(ok); console.log(`${ok?'ok  ':'FAIL'}  ${n}${d?`  — ${d}`:''}`); };
const browser = await chromium.launch({ channel:'chrome', headless:true, args:['--enable-unsafe-webgpu','--enable-features=Vulkan,WebGPU','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport:{width:1600,height:950} });
const errs = []; page.on('pageerror', e => errs.push(e.message));
try {
  // ---- BRAIN: circuits panel ----
  await page.goto(`${BASE}/brain?dataset=fish1-released`, { waitUntil:'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('footer')?.textContent?.includes('READY'), { timeout:180000 });
  await page.waitForSelector('text=Hindbrain motion integrator', { timeout:30000 });
  rec('BRAIN shows the CIRCUITS entry', true);
  // The renderer initialises after the data reports READY; give it a moment.
  await page.waitForTimeout(3000);
  await page.click('button:has-text("FOCUS CIRCUIT")');
  await page.waitForSelector('button:has-text("SHOW ALL")', { timeout:30000 });
  const cells = await page.textContent('.projection');
  rec('focusing loads the measured circuit', /865/.test(cells ?? ''), (cells ?? '').match(/[\d,]+ with a soma position/)?.[0]);
  rec('focus reports population counts by published label', /Class I/.test(cells ?? '') && /Traced input layer/.test(cells ?? ''));
  await page.click('button:has-text("SHOW ALL")');
  await page.waitForTimeout(800);

  // ---- WORLD: controller modes ----
  await page.goto(`${BASE}/world`, { waitUntil:'domcontentloaded' });
  await page.waitForSelector('button:has-text("NEURAL HMI")', { timeout:120000 });
  await page.waitForTimeout(3000);
  const offBadge = await page.textContent('.panel--right');
  rec('WORLD starts with coupling OFF', /COUPLING OFF/.test(offBadge ?? ''));
  const disabled = await page.isDisabled('button:has-text("NEURAL HMI")');
  rec('neural controller becomes available once the circuit loads', !disabled);
  await page.click('button:has-text("NEURAL HMI")');
  await page.waitForTimeout(4000);
  const onBadge = await page.textContent('.panel--right');
  rec('switching to NEURAL HMI turns coupling ON', /COUPLING ON/.test(onBadge ?? ''));
  rec('WORLD reports the motor plant as procedural', /PROCEDURAL/.test(onBadge ?? ''));
  rec('WORLD shows the stimulus and model state', /Optomotor stimulus/.test(onBadge ?? '') && /(Integrating|Threshold crossed)/.test(onBadge ?? ''));
  await page.click('button:has-text("BASELINE")');
  await page.waitForTimeout(1500);
  const backOff = await page.textContent('.panel--right');
  rec('switching back turns coupling OFF', /COUPLING OFF/.test(backOff ?? ''));
  rec('no page errors', errs.length === 0, errs.slice(0,2).join(' | '));
} catch (e) { rec('integration checks completed', false, e.message); }
finally { await browser.close(); }
const failed = checks.filter(c => !c).length;
console.log(`\n${checks.length-failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
