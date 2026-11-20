import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createBrowserSmokeFixture } from './browser-smoke-fixture.mjs';

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SCREENSHOTS_DIR = path.resolve('reports/screenshots');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.kill('SIGKILL');
  await Promise.race([closed, sleep(3000)]);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForHttp(url, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // wait
    }
    await sleep(200);
  }
  throw new Error(`Timeout waiting for ${url}`);
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 1;
    this.pending = new Map();
    this.eventListeners = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
      this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.id && this.pending.has(data.id)) {
          const { resolve, reject } = this.pending.get(data.id);
          this.pending.delete(data.id);
          if (data.error) reject(new Error(JSON.stringify(data.error)));
          else resolve(data.result);
        } else if (data.method && this.eventListeners.has(data.method)) {
          this.eventListeners.get(data.method)(data.params);
        }
      };
    });
  }

  on(event, handler) {
    this.eventListeners.set(event, handler);
  }

  send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`Runtime.evaluate exception: ${res.exceptionDetails.text} (${JSON.stringify(res.exceptionDetails)})`);
    }
    return res.result?.value;
  }

  async navigateTo(url, { expectedHeading, expectedSelector, timeoutMs = 12000 } = {}) {
    let loadFired = false;
    const prevListener = this.eventListeners.get('Page.loadEventFired');
    this.on('Page.loadEventFired', (params) => {
      loadFired = true;
      if (prevListener) prevListener(params);
    });

    await this.send('Page.navigate', { url });

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (expectedHeading) {
        try {
          const headings = await this.eval(`Array.from(document.querySelectorAll('h1, h2, h3')).map(h => h.textContent || '').join(' ')`);
          if (headings.includes(expectedHeading)) {
            return;
          }
        } catch {
          // Execution context rebuilding during navigation
        }
      } else if (expectedSelector) {
        try {
          const found = await this.eval(`!!document.querySelector(${JSON.stringify(expectedSelector)})`);
          if (found) {
            return;
          }
        } catch {
          // Execution context rebuilding during navigation
        }
      } else if (loadFired) {
        return;
      }
      await sleep(100);
    }
    if (expectedHeading) {
      throw new Error(`Timeout after ${timeoutMs}ms waiting for heading "${expectedHeading}" at ${url}`);
    }
    if (expectedSelector) {
      throw new Error(`Timeout after ${timeoutMs}ms waiting for selector "${expectedSelector}" at ${url}`);
    }
  }

  async waitForSelector(selector, timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const found = await this.eval(`!!document.querySelector(${JSON.stringify(selector)})`);
        if (found) return true;
      } catch {
        // context rebuilding
      }
      await sleep(100);
    }
    throw new Error(`Timeout waiting for selector: ${selector}`);
  }

  async waitForFunction(fnStr, timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await this.eval(`(() => {
          const v = (${fnStr});
          return typeof v === 'function' ? v() : v;
        })()`);
        if (res) return res;
      } catch {
        // context rebuilding
      }
      await sleep(100);
    }
    throw new Error(`Timeout waiting for condition: ${fnStr}`);
  }

  close() {
    this.ws.close();
  }
}

async function runSmoke() {
  await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });

  const freshPort = await getFreePort();
  console.log(`1. Starting RuleCanvas Node server on fresh port: ${freshPort}`);

  const workspace = await fs.mkdtemp(path.resolve('reports', 'temp-browser-'));
  const dataFile = path.join(workspace, 'smoke.json');
  const debugPort = await getFreePort();
  await fs.writeFile(dataFile, `${JSON.stringify(createBrowserSmokeFixture(), null, 2)}\n`, 'utf8');
  let serverStderr = '';
  const server = spawn('node', ['src/server.mjs'], {
    env: { ...process.env, PORT: String(freshPort), HOST: '127.0.0.1', RULECANVAS_DATA_FILE: dataFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stderr.on('data', (d) => {
    serverStderr += d.toString();
  });

  try {
    // Assert server health check responds with 200 OK
    await waitForHttp(`http://127.0.0.1:${freshPort}/api/health`);
    console.log(`✓ RuleCanvas server started successfully on http://127.0.0.1:${freshPort}`);

    // Assert that the served HTML is the rebuilt React bundle, not legacy vanilla HTML
    const indexRes = await fetch(`http://127.0.0.1:${freshPort}/`);
    assert.equal(indexRes.status, 200, 'Expected 200 OK for root HTML');
    const indexHtml = await indexRes.text();
    assert(
      indexHtml.includes('<div id="root">') && indexHtml.includes('/assets/index-'),
      'Served index.html does not contain the compiled React production bundle reference'
    );
    console.log('✓ Server verified serving compiled React production assets from dist/');

    const tempProfile = path.join(workspace, 'browser-profile');
    const edge = spawn(EDGE_PATH, [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${tempProfile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
    ]);

    try {
      const cdpBase = `http://127.0.0.1:${debugPort}`;
      await waitForHttp(`${cdpBase}/json/version`);
      console.log(`✓ Edge headless CDP ready on port ${debugPort}`);

      let pagesRes = await fetch(`${cdpBase}/json/list`);
      let pages = await pagesRes.json();
      let target = pages.find((p) => p.type === 'page');

      if (!target) {
        const putRes = await fetch(`${cdpBase}/json/new`, { method: 'PUT' });
        target = await putRes.json();
      }

      console.log('Connecting to page target:', target.id);
      const client = new CdpClient(target.webSocketDebuggerUrl);
      await client.connect();

      // Track runtime page exceptions and console errors
      const runtimeExceptions = [];
      const consoleErrors = [];

      client.on('Runtime.exceptionThrown', (params) => {
        runtimeExceptions.push(params);
        console.error('Browser Runtime Exception:', params.exceptionDetails?.text);
      });

      client.on('Runtime.consoleAPICalled', (params) => {
        if (params.type === 'error') {
          const msg = (params.args || []).map((a) => a.value || a.description || '').join(' ');
          consoleErrors.push(msg);
          console.error('Browser Console Error:', msg);
        }
      });

      // Automatically handle and accept native window.confirm dialogs (e.g. Delete Node confirmation)
      client.on('Page.javascriptDialogOpening', async (params) => {
        console.log(`✓ Handled native browser dialog: "${params.message}" (Accepted)`);
        await client.send('Page.handleJavaScriptDialog', { accept: true });
      });

      await client.send('Page.enable');
      await client.send('DOM.enable');
      await client.send('Runtime.enable');
      await client.send('Page.navigate', { url: `http://127.0.0.1:${freshPort}/` });

      // Viewport 1366x549 desktop (specific review test viewport)
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: 1366,
        height: 549,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(1500);

      // Verify React root is mounted and not legacy vanilla HTML
      const isReactApp = await client.eval(`(() => {
        const root = document.querySelector('#root');
        return !!root && root.children.length > 0;
      })()`);
      assert(isReactApp, 'React application #root element is empty or missing');
      console.log('✓ React app bundle verified mounted in #root');

      await client.waitForFunction(`() => Boolean(document.querySelector('main h1'))`);
      const homeOverflow = await client.eval(`document.documentElement.scrollWidth > window.innerWidth`);
      assert(!homeOverflow, 'Horizontal overflow detected on the public home (1366px)');
      const homeDesktop = await client.send('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(path.join(SCREENSHOTS_DIR, '00_home_1366px.png'), Buffer.from(homeDesktop.data, 'base64'));

      await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      assert(!(await client.eval(`document.documentElement.scrollWidth > window.innerWidth`)), 'Horizontal overflow detected on the public home (390px)');
      const homeMobile = await client.send('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(path.join(SCREENSHOTS_DIR, '00_home_390px.png'), Buffer.from(homeMobile.data, 'base64'));
      await client.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 549, deviceScaleFactor: 1, mobile: false });

      assert(await client.eval(`(() => {
        const cta = Array.from(document.querySelectorAll('button, a')).find(element => element.textContent.trim() === 'Open workspace');
        cta?.click();
        return Boolean(cta);
      })()`), 'Public home is missing its workspace entry.');
      await client.waitForFunction(`() => window.location.pathname === '/projects' && document.querySelector('h1')?.textContent === 'Your decision workspace'`);
      console.log('✓ Public homepage and workspace entry verified at desktop and mobile viewports');

      // Step 1: Dashboard View
      console.log('--- Step 1: Dashboard View ---');
      const dashboardTitle = await client.eval(`document.querySelector('h1')?.textContent || ''`);
      assert.equal(dashboardTitle.trim(), 'Your decision workspace');
      assert(await client.eval(`Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === 'Try guided example')`), 'Guided onboarding is missing in a populated workspace');

      // Check overflow on desktop
      const isDashboardOverflow = await client.eval(`document.documentElement.scrollWidth > window.innerWidth`);
      assert(!isDashboardOverflow, 'Horizontal overflow detected on Dashboard view (1366px)');

      const ssDashboard = await client.send('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(
        path.join(SCREENSHOTS_DIR, '01_dashboard_1351px.png'),
        Buffer.from(ssDashboard.data, 'base64')
      );

      // Verify and click Project Card
      const projectCard = await client.eval(`(() => {
        const row = Array.from(document.querySelectorAll('[role="row"], tr'))
          .find(candidate => candidate.textContent.includes('RuleCanvas Acceptance'));
        const openButton = row && Array.from(row.querySelectorAll('button'))
          .find(button => button.textContent.trim() === 'Open');
        if (!openButton) return null;
        openButton.click();
        return { clicked: true, text: row.textContent.trim().slice(0, 60) };
      })()`);
      assert(projectCard && projectCard.clicked, 'Failed to find or click project card on dashboard');
      console.log(`✓ Clicked project card: "${projectCard.text}"`);

      // Assert transition to Project Overview screen
      let inProjectView = false;
      for (let i = 0; i < 20; i++) {
        await sleep(150);
        inProjectView = await client.eval(`Array.from(document.querySelectorAll('h1, h2')).some(heading => heading.textContent.includes('RuleCanvas Acceptance'))`);
        if (inProjectView) break;
      }
      assert(inProjectView, 'Screen transition failed: not on Project Overview view after clicking project card');
      console.log('✓ Screen transition to Project Overview verified');

      // Step 2: Project Overview View
      console.log('--- Step 2: Project Overview View ---');
      const isProjectOverflow = await client.eval(`document.documentElement.scrollWidth > window.innerWidth`);
      assert(!isProjectOverflow, 'Horizontal overflow detected on Project Overview view (1366px)');

      const ssProject = await client.send('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(
        path.join(SCREENSHOTS_DIR, '02_project_overview_1351px.png'),
        Buffer.from(ssProject.data, 'base64')
      );

      // Verify "History" button opens Version History Modal for the specific ruleset
      console.log('Testing History button click...');
      const historyClicked = await client.eval(`(() => {
        const btn = document.querySelector('button[aria-label="Version history for Grouped decision"]');
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      assert(historyClicked, 'Could not find or click History button in ruleset table');

      let modalOpened = false;
      for (let i = 0; i < 20; i++) {
        await sleep(150);
        modalOpened = await client.eval(`!!document.querySelector('[role="dialog"]') && document.body.textContent.includes('Version History')`);
        if (modalOpened) break;
      }
      assert(modalOpened, 'Version History modal failed to open upon clicking History');
      console.log('✓ Version History modal opened with explicit target ruleset');

      // Close modal and wait for modal dialog to be fully dismissed
      const modalClosed = await client.eval(`(() => {
        const closeBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Close'));
        if (!closeBtn) return false;
        closeBtn.click();
        return true;
      })()`);
      assert(modalClosed, 'Could not find or click Close button on Version History modal');
      await client.waitForFunction(`() => !document.querySelector('[role="dialog"]')`, 5000);

      // Verify URL and UI after closing Version History: must return to Project Overview
      const afterClosePath = await client.eval(`window.location.pathname`);
      assert(
        afterClosePath.startsWith('/projects/') && !afterClosePath.includes('/rules/'),
        `Expected Project Overview URL after closing Version History, got: ${afterClosePath}`
      );
      const isOverviewVisible = await client.eval(`(() => {
        const heading = document.querySelector('h1');
        return !!heading && heading.textContent.includes('RuleCanvas Acceptance');
      })()`);
      assert(isOverviewVisible, 'Project name heading not visible after closing Version History');
      console.log('✓ Verified URL and UI returned to Project Overview after closing Version History modal');

      // Test safe browser Back from Version History modal
      console.log('Testing safe browser Back from Version History modal...');
      await client.eval(`(() => {
        const btn = document.querySelector('button[aria-label="Version history for Grouped decision"]');
        if (btn) btn.click();
      })()`);
      await client.waitForFunction(`() => !!document.querySelector('[role="dialog"]')`, 5000);
      await client.eval(`window.history.back()`);
      await client.waitForFunction(`() => !document.querySelector('[role="dialog"]')`, 5000);
      const afterBackPath = await client.eval(`window.location.pathname`);
      assert(
        afterBackPath.startsWith('/projects/') && !afterBackPath.includes('/rules/'),
        `Expected Project Overview URL after browser Back from Version History, got: ${afterBackPath}`
      );
      console.log('✓ Safe browser Back from Version History modal verified');

      // Click "Open Editor" specifically for the "Grouped decision" ruleset to verify long breadcrumb
      console.log('Testing Open Editor for "Grouped decision" ruleset...');
      let openEditorClicked = false;
      for (let attempt = 0; attempt < 25; attempt++) {
        openEditorClicked = await client.eval(`(() => {
          const rows = Array.from(document.querySelectorAll('[role="row"], tr'));
          const groupedRow = rows.find(r => r.textContent.includes('Grouped decision'));
          if (!groupedRow) return false;
          const btn = Array.from(groupedRow.querySelectorAll('button')).find(b => b.textContent.trim() === 'Open');
          if (btn && !btn.disabled) {
            btn.click();
            return true;
          }
          return false;
        })()`);
        if (openEditorClicked) break;
        await sleep(150);
      }
      assert(openEditorClicked, 'Could not find or click Open button specifically in Grouped decision row');

      // Wait for Editor Canvas screen transition
      await client.waitForSelector('#graph-canvas');
      const step2ActiveRulePath = await client.eval(`window.location.pathname`);
      assert(
        step2ActiveRulePath.includes('76149001-0d7c-4406-9b6a-c6e4244bc6e8'),
        `Expected Grouped decision rule in pathname after Open Editor, got: ${step2ActiveRulePath}`
      );
      console.log('✓ Screen transition to Editor Canvas verified (#graph-canvas rendered, Grouped decision active)');

      // Step 3: Editor Canvas at 1366x549
      console.log('--- Step 3: Editor Canvas at 1366x549 ---');
      const isEditorOverflow = await client.eval(`document.documentElement.scrollWidth > window.innerWidth`);
      assert(!isEditorOverflow, 'Horizontal overflow detected on Editor Canvas view (1366px)');

      // Verify breadcrumb is on a single compact line and does NOT expand header height
      const headerMetrics = await client.eval(`(() => {
        const header = document.querySelector('header');
        const nav = document.querySelector('header nav');
        const headerRect = header ? header.getBoundingClientRect() : null;
        const navRect = nav ? nav.getBoundingClientRect() : null;
        const text = nav ? nav.textContent : '';
        return {
          headerHeight: headerRect ? Math.round(headerRect.height) : 0,
          navHeight: navRect ? Math.round(navRect.height) : 0,
          breadcrumbText: text,
        };
      })()`);
      console.log('Header metrics at 1366x549:', headerMetrics);
      assert(headerMetrics.headerHeight <= 56, `Header height exceeded 56px: got ${headerMetrics.headerHeight}px`);
      assert(headerMetrics.navHeight <= 36, `Breadcrumb wrapped into multiple lines: height ${headerMetrics.navHeight}px`);
      console.log('✓ Breadcrumb compact single-line layout verified (no multi-line header expansion)');

      // Verify exactly ONE Undo and ONE Redo button exist in the entire UI (in the header, not duplicated on canvas)
      const undoCount = await client.eval(`document.querySelectorAll('button[aria-label="Undo"]').length`);
      assert.equal(undoCount, 1, `Expected exactly 1 Undo button in UI, found ${undoCount}`);
      const redoCount = await client.eval(`document.querySelectorAll('button[aria-label="Redo"]').length`);
      assert.equal(redoCount, 1, `Expected exactly 1 Redo button in UI, found ${redoCount}`);
      console.log('✓ Single canonical Undo/Redo control set verified (no duplicate canvas toolbar buttons)');

      const ssEditor = await client.send('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(
        path.join(SCREENSHOTS_DIR, '03_editor_canvas_1351px.png'),
        Buffer.from(ssEditor.data, 'base64')
      );
      await fs.writeFile(
        path.join(SCREENSHOTS_DIR, '03_editor_grouped_decision_1366x549.png'),
        Buffer.from(ssEditor.data, 'base64')
      );

      // Verify resource-addressed URL in browser
      const editorUrl = await client.eval(`window.location.pathname`);
      assert(editorUrl.startsWith('/projects/'), `Expected URL to start with /projects/, got ${editorUrl}`);
      assert(editorUrl.includes('/rules/'), `Expected URL to include /rules/, got ${editorUrl}`);
      console.log(`✓ Resource-addressed route verified: ${editorUrl}`);

      // Switch SegmentedControl tab to "Test Run" on the valid existing graph
      console.log('Testing SegmentedControl tab switch to "Test Run"...');
      const tabClicked = await client.eval(`(() => {
        const tab = Array.from(document.querySelectorAll('button, [role="button"]')).find(el => el.textContent.includes('Test Run'));
        if (!tab) return false;
        tab.click();
        return true;
      })()`);
      assert(tabClicked, 'Could not find or click Test Run segmented tab');

      let testRunnerMounted = false;
      for (let i = 0; i < 20; i++) {
        await sleep(150);
        testRunnerMounted = await client.eval(`document.querySelector('h3')?.textContent.includes('Run Test Evaluation') || false`);
        if (testRunnerMounted) break;
      }
      assert(testRunnerMounted, 'Test Runner view did not mount after switching tab');
      console.log('✓ Test Runner mounted with input parameters form');

      // Verify panel sync in URL
      const testTabUrl = await client.eval(`window.location.pathname + window.location.search`);
      assert(testTabUrl.includes('?panel=test'), `Expected URL query to include ?panel=test, got ${testTabUrl}`);
      console.log(`✓ Panel query route verified: ${testTabUrl}`);

      // Release Check 1: Reload tab and verify resolution to the same rule and panel
      console.log('Testing page reload persistence for rule and ?panel=test...');
      await client.send('Page.reload');
      await sleep(1500);
      const reloadedUrl = await client.eval(`window.location.pathname + window.location.search`);
      assert.equal(reloadedUrl, testTabUrl, `Reload did not preserve URL: got ${reloadedUrl}`);
      const isTestStillActive = await client.eval(`document.querySelector('h3')?.textContent.includes('Run Test Evaluation') || false`);
      assert(isTestStillActive, 'Test runner panel did not remain active after reload');
      console.log('✓ Release Check 1 passed: Reload preserved exact rule and ?panel=test');

      // Step 4: Fill valid input value, execute evaluation, and verify StepPlayer trace
      console.log('--- Step 4: Fill Test Input & Evaluate Trace ---');
      // Populate samples first to ensure all schema fields are valid
      await client.eval(`(() => {
        const fillBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Fill samples'));
        if (fillBtn) fillBtn.click();
      })()`);
      await sleep(200);

      const inputFound = await client.eval(`(() => {
        const input = document.querySelector('input');
        if (!input) return null;
        input.focus();
        return { placeholder: input.placeholder, ariaLabel: input.getAttribute('aria-label') };
      })()`);
      assert(inputFound, 'Could not find schema input field in Test Runner form');
      console.log('Found input field in Test Runner:', inputFound);

      // Send keyboard input text via CDP
      await client.send('Input.insertText', { text: '150' });
      await client.eval(`(() => {
        const input = document.querySelector('input');
        if (input) {
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.blur();
          input.dispatchEvent(new Event('blur', { bubbles: true }));
        }
      })()`);
      await sleep(300);

      // Click "Run test"
      console.log('Testing "Run test" button click on valid graph...');
      const runClicked = await client.eval(`(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Run test') || b.textContent.includes('Evaluating'));
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      assert(runClicked, 'Could not find or click Run test button');

      // Verify Evaluation Output Banner & RareUI StepPlayer Trace
      let evalData = null;
      for (let attempt = 0; attempt < 35; attempt++) {
        await sleep(300);
        evalData = await client.eval(`(() => {
          const text = document.body.textContent || '';
          const inner = document.body.innerText || '';
          const hasApproved = text.includes('APPROVED') || inner.includes('APPROVED');
          const hasDeclined = text.includes('DECLINED') || inner.includes('DECLINED');
          const hasComplete = text.includes('Evaluation Complete') || inner.includes('Evaluation Complete');
          const stepPlayerEl = document.querySelector('[data-slot="step-player"]');
          const hasStepPlayer = !!stepPlayerEl || text.includes('Decision Trace Playback') || inner.includes('Decision Trace Playback');
          const hasSteps = (text.includes('Step 1') || inner.includes('Step 1')) && (text.includes('Step 2') || text.includes('Outcome') || inner.includes('Outcome'));
          return {
            ok: (hasApproved || hasDeclined || hasComplete) && hasStepPlayer && hasSteps,
            hasOutcome: hasApproved || hasDeclined || hasComplete,
            outcomeType: hasApproved ? 'APPROVED' : hasDeclined ? 'DECLINED' : 'COMPLETE',
            hasStepPlayer,
            hasSteps,
            toasts: Array.from(document.querySelectorAll('[data-sonner-toast], [role="status"], [role="alert"]')).map(t => t.textContent),
            buttonTexts: Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()),
            snippet: inner.slice(0, 500),
          };
        })()`);
        if (evalData?.ok) break;
      }
      if (!evalData?.ok) {
        console.error('Debug Evaluation failure:', JSON.stringify(evalData));
      }
      assert(evalData && evalData.hasOutcome, `Expected evaluation outcome (APPROVED/DECLINED), got: ${evalData?.snippet}`);
      assert(evalData.hasStepPlayer, 'RareUI StepPlayer component missing from decision trace playback');
      assert(evalData.hasSteps, 'Trace steps missing from execution log');
      console.log(`✓ Evaluation verified: Outcome = ${evalData.outcomeType}, RareUI StepPlayer trace rendered`);

      const ssTest = await client.send('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(
        path.join(SCREENSHOTS_DIR, '04_test_runner_trace_1351px.png'),
        Buffer.from(ssTest.data, 'base64')
      );

      // Step 5: Canvas Authoring (Add Condition and Delete Node)
      console.log('--- Step 5: Canvas Authoring (Add Condition & Delete Node) ---');
      const initialNodeCount = await client.eval(`document.querySelectorAll('g.cursor-move').length`);
      console.log(`Initial node count on canvas: ${initialNodeCount}`);

      const addNodeClicked = await client.eval(`(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Add Condition'));
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      assert(addNodeClicked, 'Could not find or click Add Condition toolbar button');
      await sleep(600);

      const newNodeCount = await client.eval(`document.querySelectorAll('g.cursor-move').length`);
      assert.equal(newNodeCount, initialNodeCount + 1, 'Node count did not increment after clicking Add Condition');
      console.log(`✓ Node count incremented to ${newNodeCount} after Add Condition`);

      // Use the real keyboard port controls to attempt a cycle. Keep the original branch intact on rejection.
      const keyPort = async (label, nodeIndex = null) => {
        const found = await client.eval(`(() => {
          const scope = ${nodeIndex === null ? "document.querySelector('#graph-canvas')" : `document.querySelectorAll('#graph-canvas g.cursor-move')[${nodeIndex}]`};
          const port = scope?.querySelector(${JSON.stringify(`[aria-label="${label}"]`)});
          if (!port) return false;
          port.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          return true;
        })()`);
        assert(found, `Missing graph port: ${label}`);
      };
      await keyPort('Connect true branch from score');
      await keyPort('Connect into score', 4);
      await client.waitForFunction(`() => document.querySelector('#graph-canvas [aria-label="Connection from score to score; press Enter to select, Delete to remove"]') !== null`);
      const beforeCycle = await client.eval(`document.querySelectorAll('#graph-canvas [aria-label*="Connection from"]').length`);
      await keyPort('Connect true branch from score', 4);
      await client.waitForFunction(`() => document.body.textContent.includes('Connecting from')`);
      await keyPort('Connect into score', 1);
      await client.waitForFunction(`() => document.body.textContent.includes('Connection rejected because it would create a cycle.')`);
      assert.equal(await client.eval(`document.querySelectorAll('#graph-canvas [aria-label*="Connection from"]').length`), beforeCycle);
      assert(await client.eval(`!!document.querySelector('#graph-canvas [aria-label="Connection from score to score; press Enter to select, Delete to remove"]')`));
      console.log('✓ Cyclic keyboard connection rejected without changing existing branches');

      // Both branches may converge on the same valid outcome.
      await keyPort('Connect false branch from score');
      await keyPort('Connect into Eligible');
      await client.waitForFunction(`() => document.querySelectorAll('#graph-canvas [aria-label="Connection from score to Eligible; press Enter to select, Delete to remove"]').length === 1`);
      await keyPort('Connect true branch from score');
      await keyPort('Connect into Eligible');
      await client.waitForFunction(`() => document.querySelectorAll('#graph-canvas [aria-label="Connection from score to Eligible; press Enter to select, Delete to remove"]').length === 2`);
      console.log('✓ Converging branches accepted through keyboard port controls');
      // Restore fixture branches for subsequent editor checks.
      await keyPort('Connect false branch from score', 1);
      await keyPort('Connect into Review');
      await client.waitForFunction(`() => document.querySelector('#graph-canvas [aria-label="Connection from score to Review; press Enter to select, Delete to remove"]') !== null`);
      await client.eval(`document.querySelectorAll('#graph-canvas g.cursor-move')[4].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);

      // Verify Delete Node toolbar button to remove the added condition node
      console.log('Testing Canvas Authoring (Delete Node)...');
      const deleteNodeClicked = await client.eval(`(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Delete Node'));
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      assert(deleteNodeClicked, 'Could not find or click Delete Node button');
      await client.waitForFunction(`() => !!document.querySelector('[role="alertdialog"]')`);
      await client.eval(`Array.from(document.querySelectorAll('[role="alertdialog"] button')).find(button => button.textContent.trim() === 'Delete node').click()`);
      await client.waitForFunction(`() => document.querySelectorAll('g.cursor-move').length === ${initialNodeCount}`);

      const restoredNodeCount = await client.eval(`document.querySelectorAll('g.cursor-move').length`);
      assert.equal(restoredNodeCount, initialNodeCount, 'Node count did not restore to initial after clicking Delete Node');
      console.log(`✓ Node count restored to ${restoredNodeCount} after Delete Node`);

      // Verify Edge Selection and "Remove Link" toolbar button with Undo restoration
      console.log('Testing Edge Selection and "Remove Link" with undo...');
      const initialEdgeCount = await client.eval(`document.querySelectorAll('#graph-canvas [aria-label*="Connection from"]').length`);
      console.log(`Initial edge count: ${initialEdgeCount}`);
      assert(initialEdgeCount > 0, 'No edges found on canvas to test connection removal');

      // Click first edge
      const edgeClicked = await client.eval(`(() => {
        const edge = document.querySelector('#graph-canvas [aria-label*="Connection from"]');
        if (!edge) return false;
        edge.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        return true;
      })()`);
      assert(edgeClicked, 'Failed to click edge on canvas');
      await sleep(400);

      // Verify "Remove Link" button appears in the toolbar
      const removeLinkBtn = await client.eval(`(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Remove Link'));
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      assert(removeLinkBtn, '"Remove Link" button did not appear in toolbar or could not be clicked when edge was selected');
      await sleep(500);

      const edgeCountAfterRemoval = await client.eval(`document.querySelectorAll('#graph-canvas [aria-label*="Connection from"]').length`);
      assert.equal(edgeCountAfterRemoval, initialEdgeCount - 1, 'Edge count did not decrement after clicking Remove Link');
      console.log(`✓ Remove Link verified: edge count decreased to ${edgeCountAfterRemoval}`);

      // Test Undo restores the deleted connection
      const undoBtn = await client.eval(`(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Undo');
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      assert(undoBtn, 'Undo button not found in canvas controls');
      await sleep(500);

      const edgeCountAfterUndo = await client.eval(`document.querySelectorAll('#graph-canvas [aria-label*="Connection from"]').length`);
      assert.equal(edgeCountAfterUndo, initialEdgeCount, 'Undo failed to restore the removed connection edge');
      console.log(`✓ Undo verified: edge count restored to ${edgeCountAfterUndo}`);

      // Test Group Node and Recursive BoardUI Accordion Subgroup editing
      console.log('Testing Logic Group Node and Recursive Accordion Subgroup editing...');
      const addGroupClicked = await client.eval(`(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Add Group'));
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      assert(addGroupClicked, 'Could not click Add Group button');
      await sleep(500);

      // Switch to Properties inspector tab
      await client.eval(`(() => {
        const tab = Array.from(document.querySelectorAll('button, [role="button"]')).find(el => el.textContent.includes('Properties'));
        if (tab) tab.click();
      })()`);
      await sleep(400);

      // Click "+ Subgroup" inside NodeInspector
      const addSubgroupClicked = await client.eval(`(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('+ Subgroup'));
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      assert(addSubgroupClicked, 'Could not find "+ Subgroup" button in NodeInspector');
      await sleep(400);

      // Assert that BoardUI Accordion renders the nested subgroup
      const hasSubgroupAccordion = await client.eval(`(() => {
        const text = document.body.textContent || '';
        const hasSubgroupBadge = text.includes('SUBGROUP');
        const hasSubgroupLogic = text.includes('Subgroup Logic');
        return hasSubgroupBadge && hasSubgroupLogic;
      })()`);
      assert(hasSubgroupAccordion, 'BoardUI Accordion subgroup failed to render in NodeInspector');
      console.log('✓ Recursive BoardUI Accordion nested subgroup verified in NodeInspector');

      // Delete the newly created group node to keep canvas clean
      const deleteGroupClicked = await client.eval(`(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Delete Node'));
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      assert(deleteGroupClicked, 'Could not find or click Delete Node button for group node');
      await client.waitForFunction(`() => !!document.querySelector('[role="alertdialog"]')`);
      await client.eval(`Array.from(document.querySelectorAll('[role="alertdialog"] button')).find(button => button.textContent.trim() === 'Delete node').click()`);
      await client.waitForFunction(`() => document.querySelector('header [aria-live="polite"]')?.textContent.startsWith('Saved · Rev')`);

      console.log('Testing keyboard multi-selection, group movement, deletion and undo...');
      const beforeMulti = await client.eval(`(() => {
        const nodes = Array.from(document.querySelectorAll('#graph-canvas g.cursor-move')).filter(node => !node.getAttribute('aria-label').startsWith('START'));
        if (nodes.length < 2) return null;
        nodes[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return nodes.slice(0, 2).map(node => ({ label: node.getAttribute('aria-label'), transform: node.getAttribute('transform') }));
      })()`);
      assert(beforeMulti, 'Expected two non-start nodes for multi-selection');
      await client.eval(`(() => {
        const nodes = Array.from(document.querySelectorAll('#graph-canvas g.cursor-move')).filter(node => !node.getAttribute('aria-label').startsWith('START'));
        nodes[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
      })()`);
      await sleep(150);
      await client.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
      await sleep(200);
      const afterMulti = await client.eval(`Array.from(document.querySelectorAll('#graph-canvas g.cursor-move')).filter(node => !node.getAttribute('aria-label').startsWith('START')).slice(0,2).map(node => node.getAttribute('transform'))`);
      const coordinates = (transform) => transform.match(/translate\(([-\d.]+),\s*([-\d.]+)\)/).slice(1).map(Number);
      for (let index = 0; index < 2; index++) {
        const before = coordinates(beforeMulti[index].transform);
        const after = coordinates(afterMulti[index]);
        assert.deepEqual(after, [before[0] + 10, before[1]], 'Both selected nodes should move together');
      }
      await client.eval(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('Delete Node')).click()`);
      await client.waitForFunction(`() => !!document.querySelector('[role="alertdialog"]')`);
      await client.eval(`Array.from(document.querySelectorAll('[role="alertdialog"] button')).find(button => button.textContent.trim() === 'Delete node').click()`);
      await client.waitForFunction(`() => document.querySelectorAll('#graph-canvas g.cursor-move').length === ${initialNodeCount - 2}`);
      assert(await client.eval(`!!document.querySelector('#graph-canvas g[aria-label^="START"]')`), 'Start node was removed');
      await client.eval(`document.querySelector('button[aria-label="Undo"]').click()`);
      await client.waitForFunction(`() => document.querySelectorAll('#graph-canvas g.cursor-move').length === ${initialNodeCount}`);
      console.log('✓ Selected nodes moved together and were restored by undo after confirmed deletion');

      // Capture the actual audit after synthetic editor changes have saved.
      await client.waitForFunction(`() => document.querySelector('header [aria-live="polite"]')?.textContent.startsWith('Saved · Rev')`);
      assert(await client.eval(`(() => {
        const button = document.querySelector('button[aria-label="Audit log"]');
        if (!button) return false;
        button.click();
        return true;
      })()`), 'Audit log action was unavailable');
      await client.waitForFunction(`() => {
        const dialog = document.querySelector('[role="dialog"]');
        return Boolean(dialog && dialog.textContent.includes('Audit Log') && dialog.textContent.includes('ruleset.draft.saved'));
      }`);
      await sleep(500);
      const auditScreenshot = await client.send('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(path.join(SCREENSHOTS_DIR, '06_audit_log.png'), Buffer.from(auditScreenshot.data, 'base64'));
      await client.eval(`(() => {
        const dialog = document.querySelector('[role="dialog"]');
        Array.from(dialog.querySelectorAll('button')).find(button => button.textContent.trim() === 'Close')?.click();
      })()`);
      await client.waitForFunction(`() => !document.querySelector('[role="dialog"]')`);
      console.log('✓ Audit log displayed saved synthetic edits and screenshot captured');

      // Release Checks 4 & 5: SITEMAP Deep Link, Version Replay & Recovery Views
      console.log('--- Step 5.5: Deep Link Routes, Version Replay & Recovery Views ---');

      // Test Direct Immutable Version Replay (/projects/:pId/rules/:rId/versions/:vId)
      const versionUrl = `http://127.0.0.1:${freshPort}/projects/f63f6117-695b-40ba-8d71-9e7df47ce566/rules/07c973f2-f12b-4040-8b73-db027627f338/versions/e661790b-f615-46ec-a402-cbe8dc7bd86e`;
      const restoreRulePath = '/api/rulesets/07c973f2-f12b-4040-8b73-db027627f338';
      const modifiedX = await client.eval(`(async () => {
        const existing = await (await fetch('${restoreRulePath}')).json();
        const graph = structuredClone(existing.ruleset.graph);
        graph.nodes[0].x += 123;
        const saved = await fetch('${restoreRulePath}', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: existing.ruleset.revision, name: existing.ruleset.name, graph }) });
        if (!saved.ok) throw new Error('Could not prepare restore fixture');
        return graph.nodes[0].x;
      })()`);
      console.log('Navigating directly to version snapshot deep-link:', versionUrl);
      await client.navigateTo(versionUrl, { expectedHeading: 'Version History' });
      await client.waitForFunction(`() => document.body.textContent.includes('Immutable Version') && document.body.textContent.includes('Verified SHA-256')`);
      console.log('✓ Release Check 5 passed: Direct immutable version deep-link opened and inspected snapshot');

      assert(await client.eval(`(() => { const button = Array.from(document.querySelectorAll('button')).find(item => item.textContent.trim() === 'Restore to draft'); button?.click(); return !!button; })()`), 'Restore action missing');
      await client.waitForFunction(`() => !!document.querySelector('[role="alertdialog"]')`);
      assert(await client.eval(`(() => { const dialog = document.querySelector('[role="alertdialog"]'); const button = Array.from(dialog.querySelectorAll('button')).find(item => item.textContent.trim() === 'Restore draft'); button?.click(); return !!button; })()`), 'Restore confirmation missing');
      await client.waitForFunction(`() => !document.querySelector('[role="dialog"]') && !!document.querySelector('#graph-canvas')`);
      await client.waitForFunction(`async () => (await (await fetch('${restoreRulePath}')).json()).ruleset.graph.nodes[0].x !== ${modifiedX}`, 16000);
      assert(await client.eval(`(() => { const button = document.querySelector('button[aria-label="Undo"]'); if (!button || button.disabled) return false; button.click(); return true; })()`), 'Restore was not undoable');
      await client.waitForFunction(`async () => (await (await fetch('${restoreRulePath}')).json()).ruleset.graph.nodes[0].x === ${modifiedX}`, 16000);
      console.log('✓ Version restore saved the snapshot and Undo restored the previous draft');

      await client.navigateTo(versionUrl, { expectedHeading: 'Version History' });
      await client.waitForFunction(`() => document.body.textContent.includes('Immutable Version')`);

      // Test direct version deep-link modal close destination fallback to Editor
      console.log('Testing direct version deep-link modal close destination fallback...');
      await client.eval(`(() => {
        const closeBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Close'));
        if (closeBtn) closeBtn.click();
      })()`);
      await client.waitForFunction(`() => !document.querySelector('[role="dialog"]')`, 5000);
      const afterDirectClosePath = await client.eval(`window.location.pathname`);
      assert(
        afterDirectClosePath.includes('07c973f2-f12b-4040-8b73-db027627f338'),
        `Expected fallback to Editor after closing direct version deep-link, got: ${afterDirectClosePath}`
      );
      console.log('✓ Direct version deep-link close destination fallback to Editor verified');

      // Test Recovery View: Missing Project ID
      const missingProjUrl = `http://127.0.0.1:${freshPort}/projects/00000000-0000-0000-0000-000000000000`;
      console.log('Navigating to missing project URL:', missingProjUrl);
      await client.navigateTo(missingProjUrl, { expectedHeading: 'Project Not Found' });

      const hasProjectNotFound = await client.eval(`(() => {
        const text = document.body.textContent || '';
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Return to Projects'));
        return text.includes('Project Not Found') && !!btn;
      })()`);
      assert(hasProjectNotFound, 'Missing project URL did not render Project Not Found recovery view');
      console.log('✓ Release Check 4 (Project Not Found) passed: Recovery screen rendered with return button');

      // Click "Return to Projects"
      await client.eval(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Return to Projects'))?.click()`);
      await client.waitForFunction(`() => window.location.pathname === '/projects'`);
      console.log('✓ Recovery navigation to /projects verified');

      // Test Recovery View: Missing Rule Set ID
      const missingRuleUrl = `http://127.0.0.1:${freshPort}/projects/f63f6117-695b-40ba-8d71-9e7df47ce566/rules/00000000-0000-0000-0000-000000000000`;
      console.log('Navigating to missing rule set URL:', missingRuleUrl);
      await client.navigateTo(missingRuleUrl, { expectedHeading: 'Rule Set Not Found' });

      const hasRuleNotFound = await client.eval(`(() => {
        const text = document.body.textContent || '';
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Back to Project'));
        return text.includes('Rule Set Not Found') && !!btn;
      })()`);
      assert(hasRuleNotFound, 'Missing rule URL did not render Rule Set Not Found recovery view');
      console.log('✓ Release Check 4 (Rule Set Not Found) passed: Recovery screen rendered with back button');

      // Test Exact Malformed URI Encoding (/projects/%ZZ)
      const exactMalformedUrl = `http://127.0.0.1:${freshPort}/projects/%ZZ`;
      console.log('Navigating to exact malformed URI URL:', exactMalformedUrl);
      await client.navigateTo(exactMalformedUrl, { expectedHeading: 'Page Not Found' });

      const exactMalformedState = await client.eval(`(() => {
        const root = document.querySelector('#root');
        const text = document.body.textContent || '';
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Return to Projects'));
        return {
          isMounted: !!root && root.children.length > 0,
          hasRecoveryScreen: text.includes('Page Not Found') && text.includes('%ZZ'),
          hasReturnBtn: !!btn,
        };
      })()`);
      assert(exactMalformedState.isMounted, 'App blanked on exact malformed URI /projects/%ZZ');
      assert(exactMalformedState.hasRecoveryScreen && exactMalformedState.hasReturnBtn, 'Exact malformed URI /projects/%ZZ did not render recovery screen');
      console.log('✓ Exact malformed URI (/projects/%ZZ) verified: App renders Page Not Found recovery screen');

      // Test Malformed URI Encoding in shared URL (/projects/proj%ZZ)
      const malformedUrl = `http://127.0.0.1:${freshPort}/projects/proj%ZZ`;
      console.log('Navigating to malformed URI URL:', malformedUrl);
      await client.navigateTo(malformedUrl, { expectedHeading: 'Page Not Found' });

      const malformedAppState = await client.eval(`(() => {
        const root = document.querySelector('#root');
        const text = document.body.textContent || '';
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Return to Projects'));
        return {
          isMounted: !!root && root.children.length > 0,
          hasRecoveryScreen: text.includes('Page Not Found') && text.includes('proj%ZZ'),
          hasReturnBtn: !!btn,
        };
      })()`);
      assert(malformedAppState.isMounted, 'App blanked on malformed URI URL');
      assert(malformedAppState.hasRecoveryScreen && malformedAppState.hasReturnBtn, 'Malformed URI URL did not render recovery screen');
      console.log('✓ Malformed URI edge case verified: App never blanks, renders Page Not Found recovery screen');

      // Test Encoded Path Separator in ID (/projects/proj%2F123)
      const encodedSlashUrl = `http://127.0.0.1:${freshPort}/projects/proj%2F123`;
      console.log('Navigating to encoded slash URL:', encodedSlashUrl);
      await client.navigateTo(encodedSlashUrl, { expectedHeading: 'Page Not Found' });

      const encodedSlashState = await client.eval(`(() => {
        const root = document.querySelector('#root');
        const text = document.body.textContent || '';
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Return to Projects'));
        return {
          isMounted: !!root && root.children.length > 0,
          hasRecoveryScreen: text.includes('Page Not Found'),
          hasReturnBtn: !!btn,
        };
      })()`);
      assert(encodedSlashState.isMounted, 'App blanked on encoded slash URL');
      assert(encodedSlashState.hasRecoveryScreen, 'Encoded slash URL did not render recovery screen');
      console.log('✓ Encoded path separator edge case verified: App never blanks, renders Page Not Found recovery screen');

      // Step 5.6: In-Browser Forced-Save History Traversal & Popstate Rejection Checks
      console.log('--- Step 5.6: In-Browser Forced-Save History Traversal & Popstate Rejection ---');
      const projOverviewUrl = `http://127.0.0.1:${freshPort}/projects/f63f6117-695b-40ba-8d71-9e7df47ce566`;
      console.log('Navigating to project overview for clean history stack baseline:', projOverviewUrl);
      await client.navigateTo(projOverviewUrl, { expectedHeading: 'RuleCanvas Acceptance' });

      // Click "Open Editor" specifically for Grouped decision ruleset (scoped to [role="row"], tr)
      const expectedRuleId = '76149001-0d7c-4406-9b6a-c6e4244bc6e8';
      const historyOpenEditorClicked = await client.eval(`(() => {
        const rows = Array.from(document.querySelectorAll('[role="row"], tr'));
        const targetRow = rows.find(r => r.textContent.includes('Grouped decision'));
        if (!targetRow) return false;
        const btn = Array.from(targetRow.querySelectorAll('button')).find(b => b.textContent.trim() === 'Open');
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      })()`);
      assert(historyOpenEditorClicked, 'Could not click Open button specifically in the Grouped decision row');
      await client.waitForSelector('#graph-canvas');

      const activeRulePath = await client.eval(`window.location.pathname`);
      assert(
        activeRulePath.includes(expectedRuleId),
        `Expected Grouped decision rule (${expectedRuleId}) in pathname, got: ${activeRulePath}`
      );
      console.log('Active rule editor path for history test:', activeRulePath);

      // Navigate to Project Overview via TopNav Rule sets button or exact expanded breadcrumb link (establishes Entry 2: Overview)
      const navToOverviewClicked = await client.eval(`(() => {
        // Option 1: Top navigation "Rule sets" button in MagneticTabs (TopNav.tsx routes its rulesets action through onNavigateProject)
        const headerButtons = Array.from(document.querySelectorAll('header button'));
        const ruleSetsBtn = headerButtons.find(b => b.textContent.includes('Rule sets'));
        if (ruleSetsBtn && !ruleSetsBtn.disabled) {
          ruleSetsBtn.click();
          return { method: 'rulesets-tab' };
        }

        // Option 2: Expand compact Ruixen breadcrumb if collapsed, then click exact project link
        const expandBtn = document.querySelector('nav[aria-label="Breadcrumb"] button[aria-label="Expand path"]');
        if (expandBtn) {
          expandBtn.click();
        }

        const breadcrumbButtons = Array.from(document.querySelectorAll('nav[aria-label="Breadcrumb"] button'));
        const projBtn = breadcrumbButtons.find(b =>
          (b.textContent.trim() === 'RuleCanvas Acceptance' || b.title === 'RuleCanvas Acceptance') &&
          b.getAttribute('aria-label') !== 'Expand path' &&
          b.getAttribute('aria-label') !== 'Collapse path'
        );
        if (projBtn) {
          projBtn.click();
          return { method: 'breadcrumb-link' };
        }
        return false;
      })()`);
      assert(navToOverviewClicked, 'Could not click TopNav Rule sets button or expanded breadcrumb link to navigate to Overview');
      console.log('Navigated to Overview using:', JSON.stringify(navToOverviewClicked));

      try {
        await client.waitForFunction(`(() => {
          const isProjectView = window.location.pathname.startsWith('/projects/') && !window.location.pathname.includes('/rules/');
          const hasOverview = Array.from(document.querySelectorAll('h1, h2')).some(h => h.textContent.includes('RuleCanvas Acceptance'));
          return isProjectView && hasOverview;
        })()`, 12000);
      } catch (err) {
        const state = await client.eval(`(() => ({
          pathname: window.location.pathname,
          headings: Array.from(document.querySelectorAll('h1, h2')).map(h => h.textContent),
          navButtons: Array.from(document.querySelectorAll('nav button, header button')).map(b => ({ text: b.textContent.trim(), title: b.title, disabled: b.disabled }))
        }))()`);
        console.error('Debug state after navigation to Overview:', JSON.stringify(state));
        throw err;
      }

      // Assert URL and heading on Project Overview
      const overviewPath = await client.eval(`window.location.pathname`);
      assert(
        overviewPath.startsWith('/projects/') && !overviewPath.includes('/rules/'),
        `Expected Project Overview URL (/projects/:projectId), got: ${overviewPath}`
      );
      const overviewHeadingVerified = await client.eval(`Array.from(document.querySelectorAll('h1, h2')).some(h => h.textContent.includes('RuleCanvas Acceptance'))`);
      assert(overviewHeadingVerified, 'Expected project name heading on Project Overview');
      console.log('✓ Successfully arrived at Project Overview (URL & heading asserted):', overviewPath);

      // Pop back to Editor A so Overview is in the forward history stack (Entry 2 -> Entry 1)
      await client.eval(`window.history.back()`);

      // Explicitly wait for the actual canvas and Add Condition action for Grouped decision after Back
      try {
        await client.waitForFunction(`(() => {
          const isExactRule = window.location.pathname.includes('${expectedRuleId}');
          const canvas = document.querySelector('#graph-canvas');
          const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Add Condition'));
          return isExactRule && !!canvas && !!btn;
        })()`, 12000);
      } catch (waitErr) {
        const debugState = await client.eval(`(() => ({
          pathname: window.location.pathname,
          search: window.location.search,
          state: window.history.state,
          length: window.history.length,
          hasCanvas: !!document.querySelector('#graph-canvas'),
          buttons: Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()).filter(Boolean).slice(0, 10)
        }))()`);
        console.error('State after browser Back:', JSON.stringify(debugState));
        throw waitErr;
      }

      // Verify exact Grouped decision URL and canvas before dirtying
      const verifiedUrlBeforeDirty = await client.eval(`window.location.pathname`);
      assert(
        verifiedUrlBeforeDirty.includes(expectedRuleId),
        `Expected Grouped decision URL (${expectedRuleId}) before dirtying, got: ${verifiedUrlBeforeDirty}`
      );
      const baselineHistoryLength = await client.eval(`window.history.length`);
      console.log(`Baseline history stack verified: length = ${baselineHistoryLength} (Entry 1: Grouped decision; Back: Overview; Forward: Overview)`);

      // Make editor dirty by adding a condition node
      const initialNodesBeforeDirty = await client.eval(`document.querySelectorAll('g.cursor-move').length`);
      const historyAddCondBtn = await client.eval(`(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Add Condition'));
        if (btn) { btn.click(); return true; }
        return false;
      })()`);
      assert(historyAddCondBtn, 'Could not click Add Condition button to dirty the draft');
      await client.waitForFunction(`() => document.querySelectorAll('g.cursor-move').length === ${initialNodesBeforeDirty + 1}`, 12000);

      // Force save failure by monkeypatching window.fetch in the browser
      console.log('Simulating draft save network failure in browser...');
      await client.eval(`(() => {
        window.__origFetch = window.fetch;
        window.fetch = async (url, opts) => {
          if (typeof url === 'string' && (url.includes('/rules/') || url.includes('ruleset')) && opts && opts.method === 'PUT') {
            throw new Error('Forced 500 Network Error during draft save');
          }
          return window.__origFetch(url, opts);
        };
      })()`);

      // 1. Test DIRTY BACK REJECTION:
      // Clicking Back attempts to go to index 0 (/projects/:pId), which leaves the editor.
      console.log('Testing DIRTY BACK REJECTION: triggering browser Back while draft is dirty...');
      const preBackState = await client.eval(`(() => ({
        path: window.location.pathname,
        state: window.history.state,
        length: window.history.length,
        hasCanvas: !!document.querySelector('#graph-canvas'),
      }))()`);
      console.log('Pre-back state:', JSON.stringify(preBackState));

      await client.eval(`window.history.back()`);

      // Wait for save flush to reject and history controller to revert via history.go(+1)
      try {
        await client.waitForFunction(`(() => {
          const isExactRule = window.location.pathname.includes('${expectedRuleId}');
          const canvas = document.querySelector('#graph-canvas');
          return isExactRule && !!canvas;
        })()`, 12000);
      } catch (backErr) {
        const postBackState = await client.eval(`(() => ({
          path: window.location.pathname,
          search: window.location.search,
          state: window.history.state,
          length: window.history.length,
          hasCanvas: !!document.querySelector('#graph-canvas'),
          headings: Array.from(document.querySelectorAll('h1, h2, h3')).map(h => h.textContent),
          toasts: Array.from(document.querySelectorAll('[role="status"], [role="alert"], [data-sonner-toast]')).map(t => t.textContent),
          bodySnippet: document.body.innerText.slice(0, 300)
        }))()`);
        console.error('Post-back state on failure:', JSON.stringify(postBackState));
        throw backErr;
      }

      // Verify Back rejection results: exact Grouped decision rule retained
      const pathAfterBack = await client.eval(`window.location.pathname`);
      assert(
        pathAfterBack.includes(expectedRuleId),
        `Expected to remain in Grouped decision editor (${expectedRuleId}) after rejected Back popstate, got: ${pathAfterBack}`
      );
      const isCanvasStillMountedAfterBack = await client.eval(`!!document.querySelector('#graph-canvas')`);
      assert(isCanvasStillMountedAfterBack, 'Editor canvas unmounted after rejected Back popstate');

      // History stack length must NOT be incremented or truncated
      const historyLengthAfterBack = await client.eval(`window.history.length`);
      assert.equal(
        historyLengthAfterBack,
        baselineHistoryLength,
        `Expected history length to remain ${baselineHistoryLength} (non-destructive history.go(+1)), got: ${historyLengthAfterBack}`
      );
      console.log('✓ Dirty Back rejection verified: reverted via history.go(+1), editor retained, stack intact');

      // 2. Test DIRTY FORWARD REJECTION:
      // Clicking Forward attempts to go to index 2 (/projects/:pId), which also leaves the editor.
      console.log('Testing DIRTY FORWARD REJECTION: triggering browser Forward while draft is dirty...');
      await client.eval(`window.history.forward()`);

      // Wait for save flush to reject and history controller to revert via history.go(-1)
      await client.waitForFunction(`(() => {
        const isExactRule = window.location.pathname.includes('${expectedRuleId}');
        const canvas = document.querySelector('#graph-canvas');
        return isExactRule && !!canvas;
      })()`, 12000);

      // Verify Forward rejection results: exact Grouped decision rule retained
      const pathAfterForward = await client.eval(`window.location.pathname`);
      assert(
        pathAfterForward.includes(expectedRuleId),
        `Expected to remain in Grouped decision editor (${expectedRuleId}) after rejected Forward popstate, got: ${pathAfterForward}`
      );
      const isCanvasStillMountedAfterForward = await client.eval(`!!document.querySelector('#graph-canvas')`);
      assert(isCanvasStillMountedAfterForward, 'Editor canvas unmounted after rejected Forward popstate');

      const historyLengthAfterForward = await client.eval(`window.history.length`);
      assert.equal(
        historyLengthAfterForward,
        baselineHistoryLength,
        `Expected history length to remain ${baselineHistoryLength} (non-destructive history.go(-1)), got: ${historyLengthAfterForward}`
      );
      console.log('✓ Dirty Forward rejection verified: reverted via history.go(-1), editor retained, stack intact');

      // 3. Test rapid Back/Forward popstates during in-flight save
      console.log('Testing rapid Back/Forward popstates during in-flight save...');
      await client.eval(`(() => {
        window.history.back();
        window.history.forward();
      })()`);
      await sleep(800);

      const isCanvasStable = await client.eval(`!!document.querySelector('#graph-canvas')`);
      assert(isCanvasStable, 'Editor canvas not stable after rapid popstates');
      console.log('✓ Rapid popstates during in-flight save handled cleanly');

      // 4. Restore original fetch
      console.log('Restoring window.fetch and testing subsequent clean navigation...');
      await client.eval(`(() => {
        if (window.__origFetch) {
          window.fetch = window.__origFetch;
          delete window.__origFetch;
        }
      })()`);

      // Clean up the added condition node via native confirm dialog
      await client.eval(`(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Delete Node'));
        if (btn) btn.click();
      })()`);
      await client.waitForFunction(`() => !!document.querySelector('[role="alertdialog"]')`);
      await client.eval(`Array.from(document.querySelectorAll('[role="alertdialog"] button')).find(button => button.textContent.trim() === 'Delete node').click()`);
      await client.waitForFunction(`() => document.querySelectorAll('g.cursor-move').length === ${initialNodesBeforeDirty}`, 12000);

      // 5. Verify preserved forward stack & subsequent clean navigation:
      console.log('Triggering clean browser Forward navigation to Overview (verifying forward stack preserved)...');
      await client.eval(`window.history.forward()`);
      await client.waitForFunction(`(() => {
        const isProjectView = window.location.pathname.startsWith('/projects/') && !window.location.pathname.includes('/rules/');
        const hasOverview = Array.from(document.querySelectorAll('h1, h2')).some(h => h.textContent.includes('RuleCanvas Acceptance'));
        return isProjectView && hasOverview;
      })()`, 12000);
      console.log('✓ Subsequent clean Forward navigation to Overview succeeded (forward stack intact)');

      console.log('Triggering clean browser Back navigation back to editor (verifying back stack preserved)...');
      await client.eval(`window.history.back()`);
      await client.waitForFunction(`(() => {
        const isExactRule = window.location.pathname.includes('${expectedRuleId}');
        const canvas = document.querySelector('#graph-canvas');
        return isExactRule && !!canvas;
      })()`, 12000);
      console.log('✓ Subsequent clean Back navigation back to editor succeeded (back stack intact)');

      // Return to working editor before mobile tests
      const editorCanvasUrl = `http://127.0.0.1:${freshPort}${activeRulePath}`;
      await client.navigateTo(editorCanvasUrl, { expectedSelector: '#graph-canvas' });

      // Step 6: Mobile Viewport 390px
      console.log('--- Step 6: Mobile 390px Viewport ---');
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: true,
      });
      await sleep(800);

      // Assert no horizontal overflow on mobile
      const isMobileOverflow = await client.eval(`document.documentElement.scrollWidth > 390`);
      assert(!isMobileOverflow, 'Horizontal overflow detected on mobile 390px viewport');

      // Assert Mobile Tools trigger button is visible
      const toolsBtnFound = await client.eval(`(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Inspector' && b.getClientRects().length > 0);
        return Boolean(btn);
      })()`);
      assert(toolsBtnFound, 'Mobile Inspector drawer trigger button not found on 390px viewport');
      const moreActionsPoint = await client.eval(`(() => {
        const button = document.querySelector('button[aria-label="More editor actions"]');
        if (!button) return null;
        const rect = button.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      assert(moreActionsPoint, 'Mobile editor actions trigger button not found');
      await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: moreActionsPoint.x, y: moreActionsPoint.y }],
      });
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await client.waitForSelector('[role="dialog"][aria-label="Editor actions"]');
      await sleep(250);
      const mobileActions = await client.eval(`Array.from(document.querySelectorAll('[role="dialog"][aria-label="Editor actions"] button'))
        .filter(button => button.getClientRects().length > 0)
        .map(button => button.textContent.trim())`);
      assert.deepEqual(mobileActions, ['Validate', 'Save version', 'Undo', 'Redo']);
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: moreActionsPoint.x, y: moreActionsPoint.y }],
      });
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await client.waitForFunction(`() => !document.querySelector('[role="dialog"][aria-label="Editor actions"]')`);
      await client.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      console.log('✓ Mobile responsive layout verified (390px, Inspector and editor actions available)');

      const ssMobile = await client.send('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(
        path.join(SCREENSHOTS_DIR, '05_mobile_390px.png'),
        Buffer.from(ssMobile.data, 'base64')
      );

      console.log('--- Step 7: Persisted project runs on mobile ---');
      const runHistoryUrl = `${projOverviewUrl}/runs`;
      await client.navigateTo(runHistoryUrl, { expectedHeading: 'Evaluation runs' });
      await client.waitForFunction(`() => Array.from(document.querySelectorAll('[role="row"], tr')).some(row => row.textContent.includes('Grouped decision'))`);
      assert.equal(await client.eval(`window.location.pathname`), new URL(runHistoryUrl).pathname);
      assert.equal(await client.eval(`document.documentElement.scrollWidth`), 390);
      console.log('✓ Project runs deep link renders the earlier evaluation without horizontal page overflow');

      console.log('--- Step 8: Saved scenario and expected outcome ---');
      await client.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
      const scenarioUrl = versionUrl.replace(/\/versions\/[^/]+$/, '?panel=test');
      const scenarioField = 'input[placeholder="e.g. Eligible applicant"]';
      const scenarioLabel = 'Score at the eligibility floor';
      await client.navigateTo(scenarioUrl, { expectedSelector: scenarioField });
      await client.eval(`document.querySelector('input[aria-label="score"]').focus()`);
      await client.send('Input.insertText', { text: '8' });
      await client.eval(`document.querySelector('input[aria-label="score"]').blur()`);
      await client.eval(`document.querySelector('${scenarioField}').focus()`);
      await client.send('Input.insertText', { text: scenarioLabel });
      const expectedSelect = 'button[aria-label="Expected outcome (optional)"], [aria-label="Expected outcome (optional)"] button';
      assert(await client.eval(`(() => {
        const trigger = document.querySelector('${expectedSelect}');
        trigger?.click();
        return Boolean(trigger);
      })()`), 'Could not open expected outcome picker');
      await client.waitForFunction(`() => Array.from(document.querySelectorAll('[role="option"]')).some(option => option.textContent.trim() === 'Eligible')`);
      await client.eval(`Array.from(document.querySelectorAll('[role="option"]')).find(option => option.textContent.trim() === 'Eligible').click()`);
      await client.eval(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Save scenario').click()`);
      const savedList = 'ul[aria-label="Saved test scenarios"]';
      await client.waitForFunction(`() => document.querySelector('${savedList}')?.textContent.includes('${scenarioLabel}')`);
      await client.navigateTo(scenarioUrl, { expectedSelector: scenarioField });
      await client.waitForFunction(`() => document.querySelector('${savedList}')?.textContent.includes('${scenarioLabel}')`);
      await client.eval(`Array.from(document.querySelector('${savedList}').querySelectorAll('button')).find(button => button.textContent.trim() === 'Load').click()`);
      await client.waitForFunction(`() => document.querySelector('input[aria-label="score"]')?.value === '8'`);
      await client.eval(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Run test').click()`);
      await client.waitForFunction(`() => Array.from(document.querySelectorAll('[role="status"]')).some(status => status.textContent.includes('${scenarioLabel}') && status.textContent.includes('PASS') && status.textContent.includes('Actual outcome: Eligible'))`);
      console.log('✓ Scenario saved, reloaded from persistence, and evaluated with PASS against the expected outcome');

      await client.navigateTo(versionUrl, { expectedHeading: 'Version History' });
      await client.waitForFunction(`() => document.body.textContent.includes('Immutable Version')`);
      await client.waitForFunction(`() => Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === 'Compare scenarios')`);
      await client.eval(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Compare scenarios').click()`);
      await client.waitForFunction(`() => document.querySelector('[aria-label="Scenario comparison"]')?.textContent.includes('${scenarioLabel}')`);
      assert(await client.eval(`document.querySelector('[aria-label="Scenario comparison"]').textContent.includes('Same')`), 'Saved scenario comparison should match identical graphs');
      const changed = await client.eval(`(async () => {
        const path = '/api/rulesets/07c973f2-f12b-4040-8b73-db027627f338';
        const { ruleset } = await (await fetch(path)).json();
        ruleset.graph.nodes.find(node => node.id === 'score-check').value = 9;
        const response = await fetch(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: ruleset.revision, graph: ruleset.graph, name: ruleset.name }) });
        return response.ok;
      })()`);
      assert(changed, 'Could not prepare a different saved draft for comparison');
      await client.eval(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Compare scenarios').click()`);
      await client.waitForFunction(`() => document.querySelector('[aria-label="Scenario comparison"]')?.textContent.includes('Changed')`);
      console.log('✓ Saved scenario compared with immutable version and pinned saved draft');

      console.log('--- Step 9: Legacy project import ---');
      const legacySchema = [{ id: 'field-score', key: 'score', label: 'Score', type: 'number', required: true, defaultValue: 8 }];
      const legacyNodes = [
        { id: 'start', type: 'start', title: 'Start', position: { x: 0, y: 0 }, nextNodeId: 'condition' },
        { id: 'condition', type: 'condition', title: 'Threshold', position: { x: 300, y: 0 }, condition: { id: 'c1', kind: 'condition', fieldKey: 'score', operator: 'gte', value: 8 }, trueTargetId: 'pass', falseTargetId: 'review' },
        { id: 'pass', type: 'outcome', title: 'Pass', position: { x: 600, y: 0 }, outcomeCode: 'PASS', category: 'approve', reason: 'Eligible', metadata: {} },
        { id: 'review', type: 'outcome', title: 'Review', position: { x: 600, y: 200 }, outcomeCode: 'REVIEW', category: 'review', reason: 'Review', metadata: {} },
      ];
      const legacy = { format: 'RuleCanvas.by.ENNORM.ProjectExport.v1', exportedAt: '2026-01-01T00:00:00.000Z', project: {
        id: 'legacy-project', name: 'Imported synthetic decision', slug: 'imported-synthetic', description: 'Synthetic migration fixture',
        schema: legacySchema, nodes: legacyNodes, auditLog: [],
        versions: [{ id: 'legacy-v1', versionNumber: 1, label: 'Initial', commitNote: 'Synthetic', createdAt: '2026-01-01T00:00:00.000Z', snapshot: { schema: legacySchema, nodes: legacyNodes } }],
        testScenarios: [{ id: 'legacy-scenario', name: 'Legacy boundary', description: 'Synthetic boundary', inputs: { score: 8 }, expectedOutcomeCode: 'PASS' }],
      } };
      const legacyFile = path.join(workspace, 'legacy-fixture.json');
      await fs.writeFile(legacyFile, JSON.stringify(legacy));
      await client.navigateTo(`http://127.0.0.1:${freshPort}/projects`, { expectedHeading: 'Your decision workspace' });
      await client.eval(`localStorage.setItem('rulecanvas.ennorm.projects.v1', 'unchanged synthetic source')`);
      await client.eval(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Import project').click()`);
      await client.waitForSelector('#legacy-project-file');
      const documentRoot = await client.send('DOM.getDocument', {});
      const fileInput = await client.send('DOM.querySelector', { nodeId: documentRoot.root.nodeId, selector: '#legacy-project-file' });
      await client.send('DOM.setFileInputFiles', { nodeId: fileInput.nodeId, files: [legacyFile] });
      await client.eval(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Review export').click()`);
      await client.waitForFunction(`() => document.querySelector('[aria-label="Import review"]')?.textContent.includes('1 versions')`);
      await client.eval(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Import project' && button.closest('[role="dialog"]')).click()`);
      await client.waitForFunction(`() => document.querySelector('h1')?.textContent === 'Imported synthetic decision'`);
      const imported = await client.eval(`fetch('/api/projects').then(response => response.json()).then(result => result.projects.find(project => project.name === 'Imported synthetic decision'))`);
      const detail = await client.eval(`fetch('/api/projects/${imported.id}').then(response => response.json())`);
      const importedRule = detail.project.rulesets[0];
      const importedVersions = await client.eval(`fetch('/api/rulesets/${importedRule.id}/versions').then(response => response.json())`);
      const importedScenarios = await client.eval(`fetch('/api/rulesets/${importedRule.id}/scenarios').then(response => response.json())`);
      assert.equal(importedVersions.versions.length, 1);
      assert.equal(importedScenarios.scenarios[0].expectedOutcomeId, 'pass');
      assert.equal(await client.eval(`localStorage.getItem('rulecanvas.ennorm.projects.v1')`), 'unchanged synthetic source');
      const original = await client.eval(`fetch('/api/projects/${imported.id}/legacy-source').then(response => response.json())`);
      assert.deepEqual(original.source, legacy);
      console.log('✓ Legacy export reviewed, imported and preserved with its version, scenario, and browser-local source untouched');

      // Assert zero runtime errors or unhandled exceptions occurred
      assert.equal(
        runtimeExceptions.length,
        0,
        `Encountered ${runtimeExceptions.length} runtime browser exceptions: ${JSON.stringify(runtimeExceptions)}`
      );
      console.log('✓ Zero runtime browser exceptions detected throughout smoke run');

      // Assert zero CSP violations
      const cspErrors = consoleErrors.filter(
        (e) => e.toLowerCase().includes('content security policy') || e.toLowerCase().includes('violates')
      );
      assert.equal(
        cspErrors.length,
        0,
        `Encountered CSP violations: ${JSON.stringify(cspErrors)}`
      );
      console.log('✓ Zero CSP violations detected');

      client.close();
      console.log('================================================================');
      console.log('ALL BROWSER SMOKE ASSERTIONS PASSED WITH ZERO REGRESSIONS!');
      console.log('================================================================');
    } finally {
      await stopChild(edge);
    }
  } finally {
    await stopChild(server);
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }).catch((error) => {
      console.warn(`Could not remove the temporary browser smoke workspace ${workspace}: ${error.message}`);
    });
  }
}

runSmoke().catch((err) => {
  console.error('Browser smoke failed:', err);
  process.exit(1);
});
