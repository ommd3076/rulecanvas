# RuleCanvas REST API Reference

The local single-user backend exposes synchronous REST endpoints for graph modeling, revision tracking, and evaluation.

## Endpoints

### 1. Projects
- GET /api/projects: List all decision modeling projects.
- GET /api/projects/:id: Get project metadata and list of rule definitions.
- POST /api/projects: Create a new project container.

### 2. Rule Evaluation
- POST /api/evaluate: Execute rule graph against supplied input dictionary.
  - Request body: { "rulesetId": "...", "inputs": { "score": 85, "active": true } }
  - Response: { "status": "COMPLETE", "outcome": "APPROVED", "trace": [...] }

### 3. Versions & Checkpoints
- GET /api/projects/:pId/rules/:rId/versions: Retrieve immutable snapshot history.
- POST /api/projects/:pId/rules/:rId/versions: Create an immutable version point.
