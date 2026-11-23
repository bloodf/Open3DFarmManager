/** Build URLs for the two distinct PostgreSQL logins in the outage fixture. */
export function outageDatabaseUrls(input: {
  port: number
  fixturePassword: string
  telemetryUser: string
  telemetryPassword: string
}) {
  const url = (user: string, password: string) =>
    `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${input.port}/fixture`
  return {
    fixture: url('fixture', input.fixturePassword),
    telemetry: url(input.telemetryUser, input.telemetryPassword),
  }
}
