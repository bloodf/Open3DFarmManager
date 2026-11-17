-- One OpenID Connect subject per account and issuer. No email column and no provider role column.
CREATE TABLE farm.oidc_identities (
  issuer text NOT NULL CHECK (issuer ~ '^https://[^[:space:]]{1,500}$' AND length(issuer) BETWEEN 8 AND 512),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 256 AND subject !~ '[[:cntrl:]]'),
  account_id text NOT NULL REFERENCES farm.session_accounts(id),
  PRIMARY KEY (issuer, subject),
  UNIQUE (account_id, issuer)
);
CREATE FUNCTION farm.oidc_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'OIDC identities are immutable';
END;
$$;
CREATE TRIGGER oidc_identity_guard BEFORE UPDATE OR DELETE ON farm.oidc_identities
  FOR EACH ROW EXECUTE FUNCTION farm.oidc_identity_guard();
CREATE TRIGGER oidc_identity_no_truncate BEFORE TRUNCATE ON farm.oidc_identities
  FOR EACH STATEMENT EXECUTE FUNCTION farm.oidc_identity_guard();
GRANT SELECT ON farm.oidc_identities TO farm_password_auth;
GRANT INSERT ON farm.oidc_identities TO farm_account_registration;
