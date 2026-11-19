-- RuleCanvas tenant-scoped workspace persistence schema
-- Migration: 001-workspaces.sql
--
-- Design Notes:
-- 1. `contents` is stored as TEXT (explicitly NOT JSONB) to preserve exact
--    key ordering, whitespace, and byte-for-byte serialization. This is critical
--    because JSONB reorders object keys alphabetically, which alters JSON.stringify
--    output and invalidates existing immutable SHA-256 rule version graph hashes.
-- 2. `tenant_id` is the primary key, strictly isolating workspace rows per tenant.
-- 3. Row locks (SELECT ... FOR UPDATE) and transactional UPSERT (ON CONFLICT DO UPDATE)
--    serialize concurrent writes across application processes.

CREATE TABLE IF NOT EXISTS rulecanvas_workspaces (
  tenant_id VARCHAR(128) PRIMARY KEY,
  contents TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rulecanvas_workspaces_tenant_id
  ON rulecanvas_workspaces (tenant_id);
