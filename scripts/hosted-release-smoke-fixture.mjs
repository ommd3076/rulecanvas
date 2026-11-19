import { createHash } from 'node:crypto';
import { createBrowserSmokeFixture } from './browser-smoke-fixture.mjs';

export function createHostedReleaseSmokeFixture() {
  const fixture = createBrowserSmokeFixture();
  const ruleset = fixture.rulesets.find((entry) => entry.name === 'New input');
  if (!ruleset) throw new Error('Hosted smoke fixture is missing the New input ruleset.');

  const firstVersion = fixture.versions.find((entry) => entry.rulesetId === ruleset.id);
  if (!firstVersion) throw new Error('Hosted smoke fixture is missing its first immutable version.');

  const secondGraph = structuredClone(ruleset.graph);
  const condition = secondGraph.nodes.find((node) => node.id === 'score-check');
  if (!condition) throw new Error('Hosted smoke graph is missing the score condition.');
  condition.value = 9;

  const secondVersionId = '5db2e7bd-04d7-4b7d-b2dc-13d3fce707d7';
  const secondVersion = {
    id: secondVersionId,
    rulesetId: ruleset.id,
    projectId: ruleset.projectId,
    versionNumber: 2,
    sourceRevision: 2,
    name: ruleset.name,
    graph: secondGraph,
    graphHash: createHash('sha256').update(JSON.stringify(secondGraph)).digest('hex'),
    createdAt: '2026-01-16T12:00:00.000Z',
  };

  ruleset.revision = 2;
  ruleset.graph = secondGraph;
  ruleset.latestVersionId = secondVersionId;
  ruleset.updatedAt = secondVersion.createdAt;
  fixture.versions.push(secondVersion);

  return fixture;
}
