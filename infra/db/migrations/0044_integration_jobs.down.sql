DROP OWNED BY farm_integration_jobs;
DROP ROLE farm_integration_jobs;
DROP TRIGGER integration_job_no_truncate ON farm.integration_jobs;
DROP TRIGGER integration_job_guard ON farm.integration_jobs;
DROP FUNCTION farm.integration_job_guard();
DROP TABLE farm.integration_jobs;
