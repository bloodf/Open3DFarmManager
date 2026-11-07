DROP TABLE farm.password_reset_tokens;
REVOKE UPDATE (password_hash) ON farm.password_credentials FROM farm_password_reset;
DROP ROLE farm_password_reset;
