# RuleCanvas Deployment Profiles

## Local-First Mode
In local development mode, RuleCanvas runs with client-side SQLite or in-memory persistence:
- Command: `npm start`
- Dev server runs on port 3000
- Zero external database dependencies required

## Hosted Mode (PostgreSQL)
For multi-tenant team collaboration and release governance:
- Environment variable: `RULECANVAS_DATABASE_URL=postgres://...`
- Schema migration: automatic on bootstrap
- Role-based release authorization: Owner, Admin, Member, Viewer
