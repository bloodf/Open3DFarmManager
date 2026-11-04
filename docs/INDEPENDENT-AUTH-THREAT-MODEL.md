# Independent authentication boundary

The user's independent-login decision supersedes the earlier shared-authentication design. This product must own its accounts, credentials, session material and host-only cookie. No private application code, credentials, account identifiers or deployment configuration has been copied into this repository.

The available plan describes password hashing with scrypt and a sealed session library. The app currently has Nuxt, Vue and its own workspace packages, but no direct session-library dependency, authentication database, credential schema or auth endpoints. This checkpoint therefore does not choose a replacement session format or implement a password algorithm. A tested established authentication library and its configuration must be reviewed before implementing issuance, password verification, recovery or account linking.

## Implemented and tested boundary

`server/utils/auth/boundary.ts` supplies a frozen cookie policy with an independent `__Host-` name, Secure, HttpOnly, SameSite=Lax and Path=/, and deliberately no Domain attribute. This is configuration data only: no browser cookie is set, sealed or verified.

The mutation-origin predicate accepts only an exact canonical HTTPS Origin matching trusted deployment configuration. Missing, opaque, multiple, malformed, credential-bearing or path-bearing origins are rejected. Origin comparison does not use the request's Host or Forwarded headers. Invalid trusted configuration throws a fixed error rather than falling back to a request-provided origin. No HTTP endpoint invokes this predicate yet.

This helper deliberately does not enable an HTTP development exception. A future development setup must be reviewed explicitly rather than silently weakening production cookies. Checking Origin is one CSRF control, not proof of login, farm membership or authorization. SameSite alone is not the mutation policy.

## Threats and required integration tests

| Threat                                  | Required control and evidence still needed                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential stuffing or enumeration      | Rate limits by account and network, generic responses, audited lockout/recovery behavior                                                       |
| Password database disclosure            | Established password KDF with calibrated cost, unique random salt, bounded input and migration tests; no plaintext passwords or custom hashing |
| Session theft or fixation               | Established session implementation, rotation after login/elevation, protected cookies, server-enforced expiry and revocation tests             |
| Cross-product session confusion         | Dedicated session material and host-only cookies; browser tests prove sibling products cannot share authentication                             |
| Cross-origin mutations and login CSRF   | Wire the origin predicate before mutations; test missing/spoofed origins; add provider-specific state/nonce/PKCE if OAuth is selected          |
| Proxy/header spoofing                   | Explicit public-origin configuration and a reviewed proxy trust boundary; never infer trusted origin from arbitrary request headers            |
| Same-origin script compromise           | CSP and output escaping; HttpOnly does not stop malicious scripts from issuing authenticated requests                                          |
| Password reset or account linking abuse | Single-use, expiring tokens, verified ownership, no automatic linking based solely on an unverified email                                      |
| Stolen or restored session state        | Define server-side revocation and restoration behavior; test logout, password reset, role changes and backups                                  |
| Sensitive data in logs                  | Redaction of passwords, session tokens, cookies, authorization headers and recovery material                                                   |

The plan's rolling-session duration and all lifecycle behavior remain unimplemented; these constants do not silently establish expiry or revocation semantics. The separate offline Connector authorization decision is unchanged. Current tests validate configuration and pure origin decisions only. They do not demonstrate a secure login system, TLS/proxy deployment, actual cookie enforcement or end-to-end authentication.
