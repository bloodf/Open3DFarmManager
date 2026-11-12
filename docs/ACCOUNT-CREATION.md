# Account creation (E2.1)

## Decision

The specification requires accounts, registration and "no admin assignment from an unverified email", but does not choose between open registration and invitation. Open registration would let any visitor of a self-hosted instance create an account, and nothing in Phase 0 needs that. The safer minimal path is implemented:

1. **First-owner bootstrap.** `POST /api/auth/bootstrap` (page `/primeiro-acesso`) creates the first account, a farm and an `owner` membership. It works only while `farm.session_accounts` is empty and only with the deployment secret in `x-bootstrap-token`. The secret comes from `NUXT_AUTH_BOOTSTRAP_TOKEN` (32+ characters, compared by SHA-256 digest in constant time). Without it, bootstrap is disabled. The existence check and inserts run in one transaction behind a transaction-scoped advisory lock, so concurrent attempts yield exactly one owner.
2. **Farm-owner invitations.** An active owner calls `POST /api/farms/{farmId}/invites` with `{ "role": "admin" | "operator" | "viewer" }` (page `/convites`). The response carries a 43-character token exactly once; only its SHA-256 digest is stored. The link has the form `/criar-conta#codigo=<token>` so the token stays in the URL fragment and out of server logs and `Referer`. Invitations are single-use, expire after 72 hours (database cap: 7 days), and can never grant `owner`.
3. **Registration with an invite.** `POST /api/auth/register` (page `/criar-conta`) takes the token in `x-invite-token` and `{ username, password }`. One transaction locks the invite, creates the account and credential, adds the membership with the invite's role and marks the invite consumed. A taken username rolls everything back and leaves the invite usable.

Both creation endpoints reuse the login pipeline: same-origin check, per-IP and per-username rate limits (`register:` key namespace), the bounded JSON body reader, scrypt hashing with its capacity bound, and the sealed host-only session cookie (`establishSession`, extracted from `login`). Passwords need 12 or more characters. Every refusal (wrong or missing secret, closed bootstrap, malformed, spent or expired invite, taken username, short password) returns the same 400 message.

OAuth/PKCE and email-based verification remain out of scope.

## Database

Migration `0024_account_registration` adds `farm.account_invites` (immutable except one consumption; deletes and truncates rejected) and the `farm_account_registration` role (member of `farm_password_auth`) with insert/select on accounts, credentials, farms, memberships and invites. The connection role used by `NUXT_AUTH_DATABASE_URL` must be a member of it for these endpoints; without registration grants the endpoints fail closed with 503.

## Known limits

- Owner status is read without a row lock during invite creation; a concurrent revocation can race one invite. The invite still grants only a non-owner role.
- Invitation delivery is out of band: the owner copies the link. No email is sent.
