CREATE TABLE IF NOT EXISTS public.hosted_tenant_memberships (
  tenant_id varchar(128) NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9_.-]{1,128}$'),
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 512),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 256),
  roles text[] NOT NULL CHECK (cardinality(roles) > 0 AND array_position(roles, NULL) IS NULL AND roles <@ ARRAY['admin', 'author', 'reviewer', 'deployer', 'runner']::text[]),
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, issuer, subject)
);
