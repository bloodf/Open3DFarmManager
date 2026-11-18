DROP TRIGGER integration_audit_retention ON farm.integration_audit;
DROP TRIGGER integration_audit_no_truncate ON farm.integration_audit;
DROP TRIGGER integration_audit_no_change ON farm.integration_audit;
DROP FUNCTION farm.integration_audit_prune_after_insert();
DROP FUNCTION farm.integration_audit_immutable();
DROP FUNCTION farm.prune_integration_audit(bigint);
DROP TABLE farm.integration_audit;
