LOCK TABLE farm.integration_alert_actions IN ACCESS EXCLUSIVE MODE;
ALTER TABLE farm.integration_alert_actions
  DROP CONSTRAINT integration_alert_actions_check;

-- Preserve the earliest acknowledgement and longest silence from existing history.
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY alert_id, app_id ORDER BY (action = 'acknowledge') DESC, acted_at, id
  ) AS position,
    max(silenced_until) OVER (PARTITION BY alert_id, app_id) AS latest_silence
  FROM farm.integration_alert_actions
), survivors AS (
  UPDATE farm.integration_alert_actions actions
  SET silenced_until = ranked.latest_silence
  FROM ranked WHERE actions.id = ranked.id AND ranked.position = 1
  RETURNING actions.id
)
DELETE FROM farm.integration_alert_actions actions
USING ranked WHERE actions.id = ranked.id AND ranked.position > 1;

CREATE UNIQUE INDEX integration_alert_actions_one_per_app
  ON farm.integration_alert_actions (alert_id, app_id);
GRANT UPDATE (action, acted_at, silenced_until) ON farm.integration_alert_actions TO farm_integration_apps;
