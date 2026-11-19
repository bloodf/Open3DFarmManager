-- 0039's issuer CHECK used a {1,500} repetition, above PostgreSQL's 255 limit, so every insert failed.
-- Same accepted set: "https://" plus 1-500 non-space characters, within the 8-512 overall bound.
ALTER TABLE farm.oidc_identities DROP CONSTRAINT oidc_identities_issuer_check;
ALTER TABLE farm.oidc_identities ADD CONSTRAINT oidc_identities_issuer_check
  CHECK (issuer ~ '^https://[^[:space:]]+$' AND length(issuer) BETWEEN 9 AND 508);
