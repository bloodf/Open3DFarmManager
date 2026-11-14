-- Keep all retained authority audit evidence.
ALTER TABLE farm.pause_authority_challenges DROP CONSTRAINT control_capability_actions;
