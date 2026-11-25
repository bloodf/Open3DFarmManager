REVOKE SELECT ON farm.library_versions, farm.library_blobs FROM farm_integration_approvals;
REVOKE UPDATE (purged_at) ON farm.library_blobs FROM farm_integration_jobs;
REVOKE SELECT ON farm.library_connector_storage FROM farm_integration_jobs;
