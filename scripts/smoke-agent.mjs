/**
 * End-to-end check of the site agent.
 *
 * The checks that matter are the negative ones: that the agent queues rather
 * than acts, and that nothing it wrote reaches the site until a person says so.
 *
 *   node scripts/smoke-agent.mjs http://localhost:3211
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const checks = [];
const record = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 2100, height: 1100 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const agentText = () => page.textContent('.agent-console');

try {
  await page.goto(`${BASE}/experiments/visual-motion?coherence=0.8&seed=42`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('.bilateral', { timeout: 180_000 });
  await page.waitForTimeout(9000);
  await page.click('button:has-text("START")');
  await page.click('button:has-text("SHOW AGENT CONSOLE")');
  await page.waitForSelector('.agent-console', { timeout: 30_000 });
  record('agent console opens', true);

  const before = await agentText();
  record('agent starts stopped', /STOPPED/.test(before ?? ''));

  await page.click('button:has-text("START AGENT")');
  await page.waitForTimeout(15000);

  const running = await agentText();
  record('agent observes the organism', /Observed the organism/.test(running ?? ''));
  record('every step names the capability it used', /site\.read/.test(running ?? ''));
  record('agent writes a note', /site\.draft/.test(running ?? ''));
  record(
    'agent asks before publishing',
    /Waiting for human approval|PENDING-APPROVAL/i.test(running ?? ''),
  );

  const pendingCount = await page.$$eval(
    '.agent-console .projection button:has-text("APPROVE")',
    (n) => n.length,
  );
  record('a request is queued for a human', pendingCount > 0, `${pendingCount} waiting`);
  record('nothing is published yet', /0 \/ \d/.test(running ?? ''));

  // Approve one and confirm it publishes.
  await page.click('.agent-console button:has-text("APPROVE")');
  await page.waitForTimeout(2500);
  const approved = await agentText();
  record('approving publishes it', /PUBLISHED/.test(approved ?? ''));

  // Composing never sends.
  await page.click('button:has-text("DRAFT A POST")');
  await page.waitForTimeout(2500);
  const composed = await agentText();
  record('composing a post produces a draft', /Draft for instagram/i.test(composed ?? ''));
  record(
    'the draft is explicitly not sent',
    /will not be sent by this application/i.test(composed ?? ''),
  );
  record(
    'the console states there is no posting capability',
    /cannot post to any platform/i.test(composed ?? ''),
  );

  const capabilities = await page.$$eval('.agent-console .kv dt', (n) =>
    n.map((d) => d.textContent.trim()),
  );
  // Four agent capabilities plus the inert sandbox echo Phase 2 registers.
  const expected = ['sandbox.echo', 'site.draft', 'site.publish', 'site.read', 'social.compose'];
  record(
    'exactly the expected capabilities are registered',
    JSON.stringify([...capabilities].sort()) === JSON.stringify(expected),
    capabilities.join(', '),
  );
  record(
    'no capability can reach the network or a shell',
    !capabilities.some((c) => /http|fetch|net|file|shell|exec|send|post$/i.test(c)),
  );

  await page.click('button:has-text("STOP AGENT")');
  await page.waitForTimeout(800);
  record('agent can be stopped', /STOPPED/.test((await agentText()) ?? ''));
  record('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  record('agent smoke test completed', false, e.message);
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
