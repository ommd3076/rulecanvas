/**
 * Client-side Route definitions and parsing for RuleCanvas.
 * Matches proposed URLs in SITEMAP.md:
 * - /projects
 * - /projects/:projectId
 * - /projects/:projectId/runs
 * - /projects/:projectId/rules/:ruleId
 * - /projects/:projectId/rules/:ruleId?panel=schema|test
 * - /projects/:projectId/rules/:ruleId/releases
 * - /projects/:projectId/rules/:ruleId/versions
 * - /projects/:projectId/rules/:ruleId/versions/:versionId
 */

/**
 * Safely decodes a URI component for resource IDs.
 * Rejects:
 * - Malformed percent escape sequences (%ZZ, %8, truncated %, etc.) that cause URIError
 * - Encoded path separators (%2f, %2F, %5c, %5C) to prevent path confusion or traversal
 * - Directory traversal segments (.. or %2e%2e) and null bytes (%00)
 * Returns the decoded string if valid, or null if malformed/unsafe.
 */
export function safeDecodeId(rawSegment) {
  if (!rawSegment || typeof rawSegment !== 'string') return null;

  // Reject encoded path separators (%2f, %2F, %5c, %5C) and null bytes explicitly
  if (/%2f|%5c|%00/i.test(rawSegment)) {
    return null;
  }

  // Reject relative traversal tokens
  if (rawSegment === '..' || rawSegment === '.' || /%2e%2e/i.test(rawSegment)) {
    return null;
  }

  try {
    const decoded = decodeURIComponent(rawSegment);
    // Ensure decoded content does not inject path separators, null bytes, or traversal
    if (
      decoded.includes('/') ||
      decoded.includes('\\') ||
      decoded.includes('\0') ||
      decoded === '..' ||
      decoded === '.'
    ) {
      return null;
    }
    return decoded;
  } catch {
    // Catches URIError (e.g. malformed escape sequence %ZZ)
    return null;
  }
}

export function parseRoute(pathname, search = '') {
  try {
    const cleanPath = (pathname || '/').replace(/\/+$/, '') || '/';

    if (cleanPath === '/') {
      return { type: 'home' };
    }

    if (cleanPath === '/projects') {
      return { type: 'projects' };
    }

    if (cleanPath === '/projects/team') {
      return { type: 'team' };
    }

    // /projects/:projectId/runs
    const runsMatch = cleanPath.match(/^\/projects\/([^/]+)\/runs$/);
    if (runsMatch) {
      const projectId = safeDecodeId(runsMatch[1]);
      if (!projectId) return { type: 'not_found', path: pathname };
      return { type: 'runs', projectId };
    }

    // /projects/:projectId
    const projectMatch = cleanPath.match(/^\/projects\/([^/]+)$/);
    if (projectMatch) {
      const projectId = safeDecodeId(projectMatch[1]);
      if (!projectId) {
        return { type: 'not_found', path: pathname };
      }
      return {
        type: 'project',
        projectId,
      };
    }

    // /projects/:projectId/rules/:ruleId/versions/:versionId
    const versionDetailMatch = cleanPath.match(
      /^\/projects\/([^/]+)\/rules\/([^/]+)\/versions\/([^/]+)$/
    );
    if (versionDetailMatch) {
      const projectId = safeDecodeId(versionDetailMatch[1]);
      const ruleId = safeDecodeId(versionDetailMatch[2]);
      const versionId = safeDecodeId(versionDetailMatch[3]);
      if (!projectId || !ruleId || !versionId) {
        return { type: 'not_found', path: pathname };
      }
      return {
        type: 'versions',
        projectId,
        ruleId,
        versionId,
      };
    }

    // /projects/:projectId/rules/:ruleId/releases
    const releasesMatch = cleanPath.match(/^\/projects\/([^/]+)\/rules\/([^/]+)\/releases$/);
    if (releasesMatch) {
      const projectId = safeDecodeId(releasesMatch[1]);
      const ruleId = safeDecodeId(releasesMatch[2]);
      if (!projectId || !ruleId) return { type: 'not_found', path: pathname };
      return { type: 'releases', projectId, ruleId };
    }

    // /projects/:projectId/rules/:ruleId/versions
    const versionsMatch = cleanPath.match(/^\/projects\/([^/]+)\/rules\/([^/]+)\/versions$/);
    if (versionsMatch) {
      const projectId = safeDecodeId(versionsMatch[1]);
      const ruleId = safeDecodeId(versionsMatch[2]);
      if (!projectId || !ruleId) {
        return { type: 'not_found', path: pathname };
      }
      return {
        type: 'versions',
        projectId,
        ruleId,
      };
    }

    // /projects/:projectId/rules/:ruleId(?panel=...)
    const editorMatch = cleanPath.match(/^\/projects\/([^/]+)\/rules\/([^/]+)$/);
    if (editorMatch) {
      const projectId = safeDecodeId(editorMatch[1]);
      const ruleId = safeDecodeId(editorMatch[2]);
      if (!projectId || !ruleId) {
        return { type: 'not_found', path: pathname };
      }
      let panel = undefined;
      if (search) {
        try {
          const searchStr = search.startsWith('?') ? search.slice(1) : search;
          const params = new URLSearchParams(searchStr);
          const rawPanel = params.get('panel');
          if (rawPanel === 'schema' || rawPanel === 'test' || rawPanel === 'properties') {
            panel = rawPanel;
          }
        } catch {
          // Ignore malformed search query parameter strings
        }
      }
      return {
        type: 'editor',
        projectId,
        ruleId,
        panel,
      };
    }

    return { type: 'not_found', path: pathname };
  } catch {
    return { type: 'not_found', path: pathname };
  }
}

export function buildRouteUrl(route) {
  if (!route) return '/';
  switch (route.type) {
    case 'home':
      return '/';
    case 'projects':
      return '/projects';
    case 'team':
      return '/projects/team';
    case 'project':
      return `/projects/${encodeURIComponent(route.projectId)}`;
    case 'runs':
      return `/projects/${encodeURIComponent(route.projectId)}/runs`;
    case 'editor': {
      const base = `/projects/${encodeURIComponent(route.projectId)}/rules/${encodeURIComponent(route.ruleId)}`;
      if (route.panel && route.panel !== 'properties') {
        return `${base}?panel=${encodeURIComponent(route.panel)}`;
      }
      return base;
    }
    case 'versions': {
      const base = `/projects/${encodeURIComponent(route.projectId)}/rules/${encodeURIComponent(route.ruleId)}/versions`;
      if (route.versionId) {
        return `${base}/${encodeURIComponent(route.versionId)}`;
      }
      return base;
    }
    case 'releases':
      return `/projects/${encodeURIComponent(route.projectId)}/rules/${encodeURIComponent(route.ruleId)}/releases`;
    case 'not_found':
    default:
      return '/projects';
  }
}

/**
 * Validates relationship and parent-child ownership between a project and ruleset.
 */
export function verifyOwnership({ project, ruleset, requestedProjectId, requestedRuleId }) {
  if (!project) {
    return { status: 'error', reason: 'project_not_found', projectId: requestedProjectId };
  }
  if (!ruleset) {
    return { status: 'error', reason: 'rule_not_found', projectId: requestedProjectId, ruleId: requestedRuleId };
  }
  if (ruleset.projectId !== requestedProjectId) {
    return {
      status: 'error',
      reason: 'project_rule_mismatch',
      projectId: requestedProjectId,
      ruleId: requestedRuleId,
      actualProjectId: ruleset.projectId,
      rulesetName: ruleset.name,
    };
  }
  return { status: 'ok', project, ruleset };
}

/**
 * Manages monotonic navigation sequences to discard stale asynchronous network responses.
 */
export function createNavigationSequenceGuard() {
  let currentSeq = 0;
  return {
    next() {
      return ++currentSeq;
    },
    isLatest(id) {
      return id === currentSeq;
    },
    current() {
      return currentSeq;
    },
  };
}

/**
 * Controller for guarded browser history traversal (Back/Forward).
 * Indexes history entries in history.state ({ ruleCanvasIndex }) and restores rejected
 * popstate via history.go(deltaToOrigin) instead of pushState, preserving the forward
 * history stack and original history entries across forced save failures in both directions.
 */
export function createGuardedHistoryController({
  getHistoryState = () => (typeof window !== 'undefined' ? window.history.state : null),
  pushState = (state, title, url) => (typeof window !== 'undefined' ? window.history.pushState(state, title, url) : null),
  replaceState = (state, title, url) => (typeof window !== 'undefined' ? window.history.replaceState(state, title, url) : null),
  go = (delta) => (typeof window !== 'undefined' ? window.history.go(delta) : null),
  isDirty = () => false,
  flushDraft = async () => {},
  onSaveError = () => {},
  onNavigate = () => {},
  parseRoute: parseRouteFn = (p, s) => ({ type: 'projects' }),
  isLeavingEditor = () => false,
} = {}) {
  let currentIndex = typeof getHistoryState()?.ruleCanvasIndex === 'number'
    ? getHistoryState().ruleCanvasIndex
    : 0;
  let isReverting = false;
  let inFlightFlush = null;
  let pendingPop = null;

  // Initialize entry index if missing
  const currentSt = getHistoryState() || {};
  if (currentSt.ruleCanvasIndex !== currentIndex) {
    replaceState({ ...currentSt, ruleCanvasIndex: currentIndex }, '', '');
  }

  return {
    getIndex() {
      return currentIndex;
    },
    setIndex(idx) {
      currentIndex = idx;
    },
    isReverting() {
      return isReverting;
    },
    async navigateTo(targetRoute, targetUrl, replace = false) {
      if (isLeavingEditor(targetRoute) && isDirty()) {
        try {
          await flushDraft();
        } catch (err) {
          onSaveError(err);
          return { allowed: false, error: err };
        }
      }

      if (replace) {
        replaceState({ ...(getHistoryState() || {}), ruleCanvasIndex: currentIndex }, '', targetUrl);
      } else {
        currentIndex += 1;
        pushState({ ruleCanvasIndex: currentIndex }, '', targetUrl);
      }

      await onNavigate(targetRoute);
      return { allowed: true };
    },
    replaceUrl(targetUrl) {
      replaceState({ ...(getHistoryState() || {}), ruleCanvasIndex: currentIndex }, '', targetUrl);
    },
    async handlePopState(popEventState, pathname, search) {
      if (isReverting) {
        isReverting = false;
        return { type: 'reverted' };
      }

      const targetRoute = parseRouteFn(pathname, search);
      const newIndex = typeof popEventState?.ruleCanvasIndex === 'number'
        ? popEventState.ruleCanvasIndex
        : currentIndex - 1;

      const originIndex = currentIndex;
      const isLeaving = isLeavingEditor(targetRoute);

      // If a flush is already in flight (rapid Back/Forward transitions), update the pending destination
      if (inFlightFlush) {
        pendingPop = {
          newIndex,
          targetRoute,
          originIndex: pendingPop?.originIndex ?? originIndex,
          isLeaving,
        };
        return inFlightFlush;
      }

      if (!isLeaving || !isDirty()) {
        currentIndex = newIndex;
        await onNavigate(targetRoute);
        return { type: 'navigated', targetRoute, index: currentIndex };
      }

      pendingPop = { newIndex, targetRoute, originIndex, isLeaving };

      inFlightFlush = (async () => {
        try {
          await flushDraft();
          const target = pendingPop;
          pendingPop = null;
          inFlightFlush = null;
          currentIndex = target.newIndex;
          await onNavigate(target.targetRoute);
          return { type: 'navigated', targetRoute: target.targetRoute, index: currentIndex };
        } catch (err) {
          const target = pendingPop;
          pendingPop = null;
          inFlightFlush = null;

          onSaveError(err);

          const browserCurrentIndex = typeof getHistoryState()?.ruleCanvasIndex === 'number'
            ? getHistoryState().ruleCanvasIndex
            : target.newIndex;

          const deltaToOrigin = target.originIndex - browserCurrentIndex;
          if (deltaToOrigin !== 0) {
            isReverting = true;
            go(deltaToOrigin);
          }
          currentIndex = target.originIndex;
          return { type: 'blocked', error: err, deltaToOrigin, index: currentIndex };
        }
      })();

      return inFlightFlush;
    },
  };
}
