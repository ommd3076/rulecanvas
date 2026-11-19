import { createHash } from 'node:crypto';
import { validGraph } from '../tests/fixtures.mjs';

const projectId = 'f63f6117-695b-40ba-8d71-9e7df47ce566';
const groupedRulesetId = '76149001-0d7c-4406-9b6a-c6e4244bc6e8';
const replayRulesetId = '07c973f2-f12b-4040-8b73-db027627f338';
const replayVersionId = 'e661790b-f615-46ec-a402-cbe8dc7bd86e';
const timestamp = '2026-01-15T12:00:00.000Z';

export function createBrowserSmokeFixture() {
  const groupedGraph = validGraph();
  const replayGraph = validGraph();
  const replayVersion = {
    id: replayVersionId,
    rulesetId: replayRulesetId,
    projectId,
    versionNumber: 1,
    sourceRevision: 1,
    name: 'New input',
    graph: replayGraph,
    graphHash: createHash('sha256').update(JSON.stringify(replayGraph)).digest('hex'),
    createdAt: timestamp,
  };

  return {
    schemaVersion: 1,
    projects: [
      {
        id: projectId,
        slug: 'rulecanvas-acceptance',
        name: 'RuleCanvas Acceptance',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    rulesets: [
      {
        id: groupedRulesetId,
        projectId,
        name: 'Grouped decision',
        revision: 1,
        status: 'draft',
        graph: groupedGraph,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: replayRulesetId,
        projectId,
        name: 'New input',
        revision: 1,
        status: 'versioned',
        latestVersionId: replayVersionId,
        graph: replayGraph,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    versions: [replayVersion],
    auditEvents: [],
  };
}
