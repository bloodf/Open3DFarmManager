DROP OWNED BY farm_integration_delivery;
DROP ROLE farm_integration_delivery;
DROP TRIGGER integration_envelope_no_truncate ON farm.integration_envelopes;
DROP TRIGGER integration_envelope_guard ON farm.integration_envelopes;
DROP FUNCTION farm.integration_envelope_guard();
DROP TABLE farm.integration_envelopes;
