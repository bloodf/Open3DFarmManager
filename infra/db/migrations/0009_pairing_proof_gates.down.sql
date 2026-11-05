REVOKE UPDATE (proof_expired_at) ON farm.pairing_requests FROM farm_pairing_runtime;
REVOKE SELECT ON farm.pairing_proofs FROM farm_pairing_runtime;
REVOKE UPDATE (agent_id) ON farm.pairing_proofs FROM farm_pairing_runtime;
DROP TRIGGER pairing_proof_expiry_lifecycle ON farm.pairing_requests;
DROP FUNCTION farm.pairing_proof_expiry_lifecycle();
ALTER TABLE farm.pairing_requests DROP COLUMN proof_expired_at;
