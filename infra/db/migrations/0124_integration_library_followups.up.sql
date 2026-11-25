-- Integration uploads apply the library quota, revive a purged record when the
-- same bytes arrive again, and approval re-checks that a held version is live.
GRANT SELECT ON farm.library_connector_storage TO farm_integration_jobs;
GRANT UPDATE (purged_at) ON farm.library_blobs TO farm_integration_jobs;
GRANT SELECT ON farm.library_versions, farm.library_blobs TO farm_integration_approvals;
