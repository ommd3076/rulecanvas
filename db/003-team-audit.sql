CREATE TABLE IF NOT EXISTS public.hosted_team_membership_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id varchar(128) NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9_.-]{1,128}$'),
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 512),
  actor_subject text NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 256),
  target_subject text NOT NULL CHECK (length(target_subject) BETWEEN 1 AND 256),
  action text NOT NULL CHECK (action IN ('member.created', 'member.updated')),
  before_roles text[],
  before_enabled boolean,
  after_roles text[] NOT NULL CHECK (cardinality(after_roles) > 0 AND array_position(after_roles, NULL) IS NULL AND after_roles <@ ARRAY['admin', 'author', 'reviewer', 'deployer', 'runner']::text[]),
  after_enabled boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (action = 'member.created' AND before_roles IS NULL AND before_enabled IS NULL)
    OR
    (action = 'member.updated' AND before_roles IS NOT NULL AND cardinality(before_roles) > 0 AND array_position(before_roles, NULL) IS NULL AND before_roles <@ ARRAY['admin', 'author', 'reviewer', 'deployer', 'runner']::text[] AND before_enabled IS NOT NULL)
  )
);
