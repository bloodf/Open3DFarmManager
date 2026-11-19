ALTER TABLE farm.oidc_identities DROP CONSTRAINT oidc_identities_issuer_check;
ALTER TABLE farm.oidc_identities ADD CONSTRAINT oidc_identities_issuer_check
  CHECK (issuer ~ '^https://[^[:space:]]{1,500}$' AND length(issuer) BETWEEN 8 AND 512);
