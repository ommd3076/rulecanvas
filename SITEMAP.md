# RuleCanvas sitemap and architecture review

RuleCanvas helps teams turn business rules into repeatable, explainable decisions. Its public home introduces the workflow and links to a separate workspace. The workspace shell resolves resources from the URL and guards navigation away from a dirty draft.

| URL | Screen and actions |
| --- | --- |
| `/` | Public product home and workspace entry |
| `/projects` | Search, open, or create a project |
| `/projects/:projectId` | List rule sets, create a rule set, inspect project activity |
| `/projects/:projectId/runs` | Filter retained evaluations, review counts and results, and open saved versions |
| `/projects/:projectId/rules/:ruleId` | Canvas and properties, validation, draft save, import and export |
| `/projects/:projectId/rules/:ruleId?panel=schema` | Edit typed inputs |
| `/projects/:projectId/rules/:ruleId?panel=test` | Enter typed inputs, run the saved draft, inspect the trace |
| `/projects/:projectId/rules/:ruleId/versions` | Browse immutable versions |
| `/projects/:projectId/rules/:ruleId/versions/:versionId` | Inspect and replay the selected snapshot |
| `/projects/:projectId/rules/:ruleId/releases` | Review approvals and manage active versions when hosted release management is enabled |

Keep temporary UI state such as zoom, selection, and unsubmitted example inputs out of URLs. Load the project and rule by ID, verify their relationship, and ignore network replies superseded by a newer navigation. Missing records get a specific recovery screen with a link to the closest valid parent. Network failures get retry controls. Serve the app shell for valid screen routes while preserving API and asset 404s.

Leaving a rule flushes the draft. A failed save retains the editor and its recovery actions. Back and Forward use the same save guard as in-app navigation. Switching panels within a rule preserves its draft. Testing requests the exact saved revision, and Save version creates a local immutable snapshot for replay.

Google AI Studio's Gemini review independently recommended resource IDs, bookmarkable editor views, guarded history transitions, and explicit recovery for missing records. It also proposed browser-side draft recovery and three-way conflict merging. Treat those as follow-up design work after route navigation is verified. Canvas coordinates and ephemeral trace positions remain session state because the app does not persist trace IDs or promise shareable camera views. Keep import and export attached to the rule draft they operate on.

## Release checks

1. Open a rule from Projects, copy the URL to a fresh tab, and reload. Both views must resolve to the same rule and panel.
2. Navigate between two rules using Back and Forward. Delay the first response and verify it cannot replace the second rule.
3. Edit during a save and leave with Back. Verify the newest draft persists. Repeat with a failed save and confirm the draft is retained and recoverable.
4. Open missing IDs and mismatched parent/child URLs. Verify stable recovery links and useful error messages. Open the public home without workspace credentials and verify the workspace entry reaches the authentication boundary.
5. Open a version directly, replay it, and compare its trace with a later draft. Verify the snapshot remains immutable.
6. Repeat navigation on mobile and by keyboard. Confirm action labels, focus order, and the ability to return to Projects.
