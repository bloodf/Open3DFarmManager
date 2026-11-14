-- Validation fails rather than discard retained capabilities with extended actions.
ALTER TABLE farm.pause_authority_challenges DROP CONSTRAINT control_capability_actions;
ALTER TABLE farm.pause_authority_challenges ADD CONSTRAINT control_capability_actions CHECK (capability IS NULL OR (capability ? 'actions' AND jsonb_typeof(capability->'actions') = 'array' AND jsonb_array_length(capability->'actions') BETWEEN 1 AND 3 AND capability->'actions' <@ '["pause","resume","cancel"]'::jsonb));
