import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRuleCanvasServer } from '../src/server.mjs';
import { JsonStore } from '../src/storage.mjs';
import { createHostedReleaseSmokeFixture } from './hosted-release-smoke-fixture.mjs';

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROJECT_ID = 'f63f6117-695b-40ba-8d71-9e7df47ce566';
const RULESET_ID = '07c973f2-f12b-4040-8b73-db027627f338';
const VERSION_1_ID = 'e661790b-f615-46ec-a402-cbe8dc7bd86e';
const VERSION_2_ID = '5db2e7bd-04d7-4b7d-b2dc-13d3fce707d7';
const ASSERTION_HEADER = 'x-rulecanvas-assertion';
const ISSUER = 'rulecanvas-local-smoke-proxy';
const AUDIENCE = 'rulecanvas-hosted-smoke';

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitForHttp(url, headers = {}, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return response;
    } catch {}
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result?.value;
  }

  async waitFor(expression, description, timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        if (await this.evaluate(expression)) return;
      } catch {}
      await sleep(120);
    }
    throw new Error(`Timed out waiting for ${description}`);
  }

  close() {
    this.ws.close();
  }
}

function signIdentity(subject, secret) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: subject,
    iat: now - 2,
    exp: now + 240,
  })}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

async function startServer(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

function buttonClickExpression(label) {
  return `(() => {
    const button = Array.from(document.querySelectorAll('button'))
      .find((item) => item.textContent.trim() === ${JSON.stringify(label)} && !item.disabled);
    if (!button) return false;
    button.click();
    return true;
  })()`;
}

function versionCardButtonExpression(versionNumber, label) {
  return `(() => {
    const card = Array.from(document.querySelectorAll('section[aria-label="Release records"] article'))
      .find((item) => item.textContent.includes('Version ${versionNumber} · source Rev ${versionNumber}'));
    const button = card && Array.from(card.querySelectorAll('button'))
      .find((item) => item.textContent.trim() === ${JSON.stringify(label)} && !item.disabled);
    if (!button) return false;
    button.click();
    return true;
  })()`;
}

async function clickVersionOption(client, versionNumber) {
  const opened = await client.evaluate(`(() => {
    const trigger = document.querySelector('button[aria-label="Saved version to propose"], [aria-label="Saved version to propose"] button');
    if (!trigger) return false;
    trigger.click();
    return true;
  })()`);
  assert(opened, 'Saved version selector was not available.');
  await client.waitFor(`Array.from(document.querySelectorAll('[role="option"]')).some((option) => option.textContent.includes('Version ${versionNumber} ·'))`, `version ${versionNumber} option`);
  const selected = await client.evaluate(`(() => {
    const option = Array.from(document.querySelectorAll('[role="option"]'))
      .find((item) => item.textContent.includes('Version ${versionNumber} ·'));
    if (!option) return false;
    option.click();
    return true;
  })()`);
  assert(selected, `Version ${versionNumber} option was not selectable.`);
}

async function enterRationale(client, value) {
  const focused = await client.evaluate(`(() => {
    const textarea = document.querySelector('textarea[aria-label="Rationale"], textarea');
    if (!textarea) return false;
    textarea.focus();
    return true;
  })()`);
  assert(focused, 'Rationale textarea was not available.');
  await client.send('Input.insertText', { text: value });
}

async function readReleaseState(client, rulesetId) {
  return client.evaluate(`fetch('/api/rulesets/${rulesetId}/releases')
    .then(async (response) => ({ status: response.status, body: await response.json() }))`);
}

async function switchIdentity(client, subject, secret) {
  await client.send('Network.setExtraHTTPHeaders', {
    headers: { [ASSERTION_HEADER]: signIdentity(subject, secret) },
  });
  await client.send('Page.reload', { ignoreCache: true });
  await client.waitFor(`document.querySelector('h1')?.textContent.includes('Releases')`, 'hosted Releases view after identity switch');
  await client.waitFor(`document.body.textContent.includes('Your roles:') && !document.body.textContent.includes('Your roles: loading')`, `${subject} role report`);
}

async function run() {
  await fs.mkdir(path.resolve('reports'), { recursive: true });
  const workspace = await fs.mkdtemp(path.resolve('reports', 'temp-release-browser-'));
  const localFile = path.join(workspace, 'local.json');
  const hostedFile = path.join(workspace, 'hosted.json');
  const fixtureText = `${JSON.stringify(createHostedReleaseSmokeFixture(), null, 2)}\n`;
  await fs.writeFile(localFile, fixtureText, 'utf8');
  await fs.writeFile(hostedFile, fixtureText, 'utf8');

  const secret = randomBytes(32);
  const rolesBySubject = new Map([
    ['smoke-author', ['author']],
    ['smoke-reviewer', ['reviewer']],
    ['smoke-deployer', ['deployer']],
  ]);
  const hostedStore = new JsonStore(hostedFile);
  const localServer = createRuleCanvasServer({ store: new JsonStore(localFile) });
  const hostedServer = createRuleCanvasServer({
    hosted: {
      assertion: { secret, issuer: ISSUER, audience: AUDIENCE },
      resolveAuthorizedStore: ({ principal }) => rolesBySubject.has(principal.subject) ? hostedStore : null,
      resolveReleaseRoles: ({ principal }) => rolesBySubject.get(principal.subject),
    },
  });
  let edge;
  let client;
  try {
    const localBase = await startServer(localServer);
    const hostedBase = await startServer(hostedServer);
    const debugPort = await getFreePort();
    const edgeProfile = path.join(workspace, 'edge-profile');
    edge = spawn(EDGE_PATH, [
      '--headless=new',
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${edgeProfile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
    ], { stdio: 'ignore' });
    await waitForHttp(`${localBase}/api/health`);
    const hostedHealth = await waitForHttp(`${hostedBase}/api/health`, {
      [ASSERTION_HEADER]: signIdentity('smoke-author', secret),
    });
    assert.equal(hostedHealth.status, 200);
    const healthBody = await hostedHealth.json();
    assert.equal(healthBody.releaseManagement, true, 'Hosted server did not advertise release management.');

    const cdpBase = `http://127.0.0.1:${debugPort}`;
    await waitForHttp(`${cdpBase}/json/version`);
    const pages = await (await fetch(`${cdpBase}/json/list`)).json();
    let page = pages.find((entry) => entry.type === 'page');
    if (!page) page = await (await fetch(`${cdpBase}/json/new`, { method: 'PUT' })).json();
    client = new CdpClient(page.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Network.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });

    const editorPath = `/projects/${PROJECT_ID}/rules/${RULESET_ID}`;
    await client.send('Page.navigate', { url: `${hostedBase}/` });
    await client.waitFor(`Boolean(document.querySelector('main h1'))`, 'public homepage without an assertion');
    const publicHomeEntered = await client.evaluate(`(() => {
      const cta = Array.from(document.querySelectorAll('button, a')).find(element => element.textContent.trim() === 'Open workspace');
      cta?.click();
      return Boolean(cta);
    })()`);
    assert(publicHomeEntered, 'Hosted home is missing its workspace entry.');
    await client.waitFor(`location.pathname === '/projects' && document.body.textContent.includes('Sign-in required')`, 'fail-closed workspace entry');
    console.log('✓ Public home loads anonymously and the workspace requires sign-in');

    await client.send('Page.navigate', { url: `${localBase}${editorPath}` });
    await client.waitFor(`!!document.querySelector('#graph-canvas')`, 'local editor canvas');
    await client.waitFor(`document.querySelector('header')?.textContent.includes('New input')`, 'local ruleset breadcrumb');
    const localReleaseButton = await client.evaluate(`Array.from(document.querySelectorAll('button')).some((button) => button.textContent.trim() === 'Releases')`);
    assert.equal(localReleaseButton, false, 'Local default mode unexpectedly exposed Releases navigation.');
    console.log('✓ Local default mode hides Releases navigation');

    await client.send('Network.setExtraHTTPHeaders', {
      headers: { [ASSERTION_HEADER]: signIdentity('smoke-author', secret) },
    });
    await client.send('Page.navigate', { url: `${hostedBase}${editorPath}` });
    await client.waitFor(`!!document.querySelector('#graph-canvas')`, 'hosted editor canvas');
    await client.waitFor(`Array.from(document.querySelectorAll('button')).some((button) => button.textContent.trim() === 'Releases')`, 'hosted Releases action');
    assert(await client.evaluate(buttonClickExpression('Releases')), 'Could not open hosted Releases.');
    await client.waitFor(`document.querySelector('h1')?.textContent.includes('Releases')`, 'Releases view');
    await client.waitFor(`document.body.textContent.includes('Your roles: author')`, 'author role report');
    console.log('✓ Hosted author identity and roles reported in Releases');

    await clickVersionOption(client, 1);
    await enterRationale(client, 'Browser smoke proposal for version one.');
    assert(await client.evaluate(buttonClickExpression('Propose release')), 'Author could not propose version one.');
    await client.waitFor(`document.body.textContent.includes('Version proposed for review.')`, 'version one proposal notice');
    const authorState = await readReleaseState(client, RULESET_ID);
    assert.equal(authorState.status, 200);
    assert.deepEqual(authorState.body.roles, ['author']);
    const firstRelease = authorState.body.policy.releases.find((release) => release.versionId === VERSION_1_ID);
    assert.equal(firstRelease?.status, 'pending_review');
    assert.equal(firstRelease?.proposedBy.id, 'smoke-author');
    assert.deepEqual(firstRelease?.proposedBy.roles, ['author']);
    assert(await client.evaluate(versionCardButtonExpression(1, '')) === false, 'Unexpected no-op button click helper result.');

    const authorCanApprove = await client.evaluate(`Array.from(document.querySelectorAll('section[aria-label="Release records"] article'))
      .filter((item) => item.textContent.includes('Version 1 · source Rev 1'))
      .some((card) => Array.from(card.querySelectorAll('button')).some((button) => button.textContent.trim() === 'Approve'))`);
    assert.equal(authorCanApprove, false, 'Author must not receive the reviewer approval action.');
    console.log('✓ Proposal reporter identity and author role verified; author cannot approve own release');

    await switchIdentity(client, 'smoke-reviewer', secret);
    assert(await client.evaluate(`document.body.textContent.includes('Your roles: reviewer')`), 'Reviewer role was not reported.');
    await enterRationale(client, 'Independent browser smoke review.');
    assert(await client.evaluate(versionCardButtonExpression(1, 'Approve')), 'Reviewer approval action was not available after rationale.');
    await client.waitFor(`document.body.textContent.includes('Release approve completed.')`, 'version one approval notice');
    let reviewerState = await readReleaseState(client, RULESET_ID);
    assert.deepEqual(reviewerState.body.roles, ['reviewer']);
    const approvedFirst = reviewerState.body.policy.releases.find((release) => release.versionId === VERSION_1_ID);
    assert.equal(approvedFirst?.status, 'approved');
    assert.equal(approvedFirst?.approvedBy.id, 'smoke-reviewer');
    assert.deepEqual(approvedFirst?.approvedBy.roles, ['reviewer']);
    console.log('✓ Reviewer identity and approval role verified');

    await switchIdentity(client, 'smoke-deployer', secret);
    assert(await client.evaluate(`document.body.textContent.includes('Your roles: deployer')`), 'Deployer role was not reported.');
    await enterRationale(client, 'Activate approved version one in staging.');
    assert(await client.evaluate(versionCardButtonExpression(1, 'Activate')), 'Deployer could not activate version one.');
    await client.waitFor(`document.body.textContent.includes('Release activate completed.')`, 'version one activation notice');
    let deployerState = await readReleaseState(client, RULESET_ID);
    assert.deepEqual(deployerState.body.roles, ['deployer']);
    assert.equal(deployerState.body.policy.deployments.find((deployment) => deployment.environment === 'staging')?.versionId, VERSION_1_ID);
    assert(deployerState.body.policy.auditTrail.some((entry) => entry.action === 'activate' && entry.actorId === 'smoke-deployer' && entry.actorRoles.includes('deployer')));
    console.log('✓ Deployer identity and staging activation verified');

    await switchIdentity(client, 'smoke-author', secret);
    const activeForm = 'section[aria-label="Test active staging release"]';
    await client.waitFor(`!!document.querySelector('${activeForm} input[aria-label="score"]')`, 'input schema of active staging version');
    await client.evaluate(`document.querySelector('${activeForm} input[aria-label="score"]').focus()`);
    await client.send('Input.insertText', { text: '8' });
    await client.evaluate(`document.querySelector('${activeForm} input[aria-label="score"]').blur()`);
    assert(await client.evaluate(`(() => {
      const form = document.querySelector('${activeForm}');
      const run = Array.from(form.querySelectorAll('button')).find(button => button.textContent.trim() === 'Run test');
      if (!run || run.disabled) return false;
      run.click();
      return true;
    })()`), 'The author could not run the active staging decision.');
    await client.waitFor(`(() => {
      const text = document.querySelector('${activeForm}')?.textContent || '';
      return text.includes('Version 1') && text.includes('Decision Trace Playback') && text.includes('"decision": "eligible"');
    })()`, 'immutable active-version result and trace').catch(async (error) => {
      const formText = await client.evaluate(`document.querySelector('${activeForm}')?.textContent.slice(-1500) || ''`);
      throw new Error(`${error.message}. Browser form displayed: ${formText}`);
    });
    const retained = await client.evaluate(`fetch('/api/projects/${PROJECT_ID}/runs').then(response => response.json())`);
    assert.equal(retained.runs.length, 1);
    assert.equal(retained.runs[0].versionId, VERSION_1_ID);
    console.log('✓ Active staging Version 1 evaluated through the browser and recorded in run history');

    await clickVersionOption(client, 2);
    await enterRationale(client, 'Browser smoke proposal for version two.');
    assert(await client.evaluate(buttonClickExpression('Propose release')), 'Author could not propose version two.');
    await client.waitFor(`document.body.textContent.includes('Version proposed for review.')`, 'version two proposal notice');
    let latestState = await readReleaseState(client, RULESET_ID);
    const secondRelease = latestState.body.policy.releases.find((release) => release.versionId === VERSION_2_ID);
    assert.equal(secondRelease?.proposedBy.id, 'smoke-author');
    assert.deepEqual(secondRelease?.proposedBy.roles, ['author']);

    await switchIdentity(client, 'smoke-reviewer', secret);
    await enterRationale(client, 'Independent browser smoke review of version two.');
    assert(await client.evaluate(versionCardButtonExpression(2, 'Approve')), 'Reviewer could not approve version two.');
    await client.waitFor(`document.body.textContent.includes('Release approve completed.')`, 'version two approval notice');
    reviewerState = await readReleaseState(client, RULESET_ID);
    const approvedSecond = reviewerState.body.policy.releases.find((release) => release.versionId === VERSION_2_ID);
    assert.equal(approvedSecond?.approvedBy.id, 'smoke-reviewer');
    assert.deepEqual(approvedSecond?.approvedBy.roles, ['reviewer']);

    await switchIdentity(client, 'smoke-deployer', secret);
    await enterRationale(client, 'Activate approved version two in staging.');
    assert(await client.evaluate(versionCardButtonExpression(2, 'Activate')), 'Deployer could not activate version two.');
    await client.waitFor(`document.body.textContent.includes('Release activate completed.')`, 'version two activation notice');
    deployerState = await readReleaseState(client, RULESET_ID);
    assert.equal(deployerState.body.policy.deployments.find((deployment) => deployment.environment === 'staging')?.versionId, VERSION_2_ID);

    await enterRationale(client, 'Rollback staging to the previous approved version.');
    assert(await client.evaluate(versionCardButtonExpression(1, 'Rollback to this version')), 'Deployer could not roll back to version one.');
    await client.waitFor(`document.body.textContent.includes('Release rollback completed.')`, 'rollback notice');
    const rolledBackState = await readReleaseState(client, RULESET_ID);
    const staging = rolledBackState.body.policy.deployments.find((deployment) => deployment.environment === 'staging');
    assert.equal(staging?.versionId, VERSION_1_ID);
    assert(rolledBackState.body.policy.auditTrail.some((entry) => entry.action === 'rollback' && entry.actorId === 'smoke-deployer' && entry.actorRoles.includes('deployer')));
    assert(rolledBackState.body.policy.auditTrail.some((entry) => entry.action === 'approve' && entry.actorId === 'smoke-reviewer' && entry.actorRoles.includes('reviewer')));
    assert(rolledBackState.body.policy.auditTrail.some((entry) => entry.action === 'propose' && entry.actorId === 'smoke-author' && entry.actorRoles.includes('author')));
    console.log('✓ Approve, activate, rollback, and trusted reporter roles verified through the hosted UI');
    console.log('HOSTED RELEASE BROWSER ACCEPTANCE PASSED');
  } finally {
    client?.close();
    if (edge?.pid && edge.exitCode === null && edge.signalCode === null) {
      const closed = new Promise((resolve) => edge.once('close', resolve));
      edge.kill('SIGKILL');
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3000).unref())]);
    }
    await closeServer(localServer);
    await closeServer(hostedServer);
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }).catch((error) => {
      console.warn(`Temporary hosted smoke workspace could not be removed: ${error.message}`);
    });
  }
}

run().catch((error) => {
  console.error('Hosted release browser acceptance failed:', error);
  process.exitCode = 1;
});
