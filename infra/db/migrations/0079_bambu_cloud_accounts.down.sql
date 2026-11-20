REVOKE UPDATE (farm_id) ON farm.memberships FROM farm_bambu_cloud;
REVOKE ALL PRIVILEGES ON farm.bambu_cloud_accounts, farm.memberships FROM farm_bambu_cloud;
REVOKE USAGE ON SCHEMA farm FROM farm_bambu_cloud;
DROP ROLE farm_bambu_cloud;
DROP TABLE farm.bambu_cloud_accounts;
