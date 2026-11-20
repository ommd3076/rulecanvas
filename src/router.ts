import {
  parseRoute as parseRouteJs,
  buildRouteUrl as buildRouteUrlJs,
  verifyOwnership as verifyOwnershipJs,
  createNavigationSequenceGuard as createNavigationSequenceGuardJs,
  safeDecodeId as safeDecodeIdJs,
  createGuardedHistoryController as createGuardedHistoryControllerJs,
} from '../public/router.js';

export type PanelType = 'properties' | 'schema' | 'test';

export type RouteState =
  | { type: 'home' }
  | { type: 'projects' }
  | { type: 'project'; projectId: string }
  | { type: 'runs'; projectId: string }
  | { type: 'editor'; projectId: string; ruleId: string; panel?: PanelType }
  | { type: 'versions'; projectId: string; ruleId: string; versionId?: string }
  | { type: 'releases'; projectId: string; ruleId: string }
  | { type: 'not_found'; path: string };

export function parseRoute(pathname: string, search: string = ''): RouteState {
  return parseRouteJs(pathname, search) as RouteState;
}

export function buildRouteUrl(route: RouteState): string {
  return buildRouteUrlJs(route);
}

export function verifyOwnership(params: {
  project?: any;
  ruleset?: any;
  requestedProjectId: string;
  requestedRuleId: string;
}) {
  return verifyOwnershipJs(params);
}

export function createNavigationSequenceGuard() {
  return createNavigationSequenceGuardJs();
}

export function safeDecodeId(rawSegment: string) {
  return safeDecodeIdJs(rawSegment);
}

export function createGuardedHistoryController(options: any) {
  return createGuardedHistoryControllerJs(options);
}
