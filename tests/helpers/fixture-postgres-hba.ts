// HBA matches names and memberships. Callers must explicitly list additional
// superusers so they require SCRAM before the ordinary test login trust rules.
// Membership rules also protect the built-in server file/program capabilities.
export function fixturePostgresHba(
  additionalScramRoles: string[] = [],
): string {
  for (const role of additionalScramRoles) {
    if (!/^[a-z_][a-z0-9_]*$/.test(role))
      throw new Error(`Invalid PostgreSQL role name: ${role}`)
  }
  const scramRoles = ['fixture', ...additionalScramRoles].join(',')
  return `
local all ${scramRoles} scram-sha-256
local all +pg_execute_server_program,+pg_read_server_files,+pg_write_server_files scram-sha-256
local all all trust
host all ${scramRoles} 127.0.0.1/32 scram-sha-256
host all +pg_execute_server_program,+pg_read_server_files,+pg_write_server_files 127.0.0.1/32 scram-sha-256
host all all 127.0.0.1/32 trust
host all ${scramRoles} ::1/128 scram-sha-256
host all +pg_execute_server_program,+pg_read_server_files,+pg_write_server_files ::1/128 scram-sha-256
host all all ::1/128 trust
`
}
