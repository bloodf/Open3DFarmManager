DROP TRIGGER integration_webhook_capture ON farm.connector_inventory_snapshots;
CREATE OR REPLACE FUNCTION farm.integration_webhook_capture()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, farm, pg_temp AS $$
DECLARE
  event_type text;
  event_uuid uuid;
  printer uuid;
  owner_app uuid;
  payload jsonb;
  resource jsonb;
  receipt jsonb;
  phase text;
BEGIN
  IF TG_TABLE_NAME IN ('printer_latest_state', 'job_history') THEN
    SELECT id INTO printer FROM farm.printer_assignments
    WHERE farm_id = NEW.farm_id AND agent_id = NEW.agent_id AND printer_key = NEW.printer_key
      AND revoked_at IS NULL;
    IF printer IS NULL THEN RETURN NULL; END IF;
    IF TG_TABLE_NAME = 'printer_latest_state' THEN
      IF TG_OP = 'UPDATE' AND OLD.state->'state' IS NOT DISTINCT FROM NEW.state->'state' THEN
        RETURN NULL;
      END IF;
      event_type := 'printer.state_changed';
      payload := jsonb_build_object(
        'printerId', printer, 'farmId', NEW.farm_id, 'printerKey', NEW.printer_key,
        'state', coalesce(NEW.state->>'state', 'unknown'), 'observedAt', NEW.observed_at,
        'progress', NEW.state->'progress', 'filename', NEW.state->'filename',
        'estimatedRemainingSeconds', NEW.state->'estimatedRemainingSeconds',
        'vendor', NEW.state#>'{identity,vendor}', 'model', NEW.state#>'{identity,model}',
        'temperatures', nullif(jsonb_strip_nulls(jsonb_build_object(
          'toolCelsius', NEW.state->'toolTemperatureCelsius',
          'bedCelsius', NEW.state->'bedTemperatureCelsius'
        )), '{}'::jsonb)
      );
    ELSE
      event_type := 'job.ended';
      payload := jsonb_build_object(
        'id', NEW.id::text, 'farmId', NEW.farm_id, 'printerId', printer,
        'outcome', NEW.outcome, 'endedAt', NEW.ended_at, 'filename', NEW.filename,
        'printDurationSeconds', NEW.print_duration_seconds, 'totalDurationSeconds', NEW.total_duration_seconds
      );
    END IF;
  ELSE
    printer := NEW.printer_assignment_id;
    owner_app := NEW.app_id;
    IF TG_TABLE_NAME = 'integration_envelopes' THEN
      -- Internal delivery phases all represent the same public queued state.
      IF NEW.status IN ('pending', 'sending', 'sent')
        OR (TG_OP = 'UPDATE' AND OLD.status = NEW.status) THEN RETURN NULL; END IF;
      receipt := to_jsonb(NEW);
      event_type := NEW.kind || '.status_changed';
      IF NEW.kind = 'job' THEN
        SELECT to_jsonb(j) INTO resource FROM farm.integration_jobs j WHERE j.id = NEW.resource_id;
      ELSE
        SELECT to_jsonb(a) INTO resource FROM farm.integration_actions a WHERE a.id = NEW.resource_id;
      END IF;
      IF resource IS NULL OR resource->>'status' <> 'submitted' THEN RETURN NULL; END IF;
      phase := NEW.status;
    ELSE
      IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN RETURN NULL; END IF;
      resource := to_jsonb(NEW);
      event_type := CASE TG_TABLE_NAME WHEN 'integration_jobs' THEN 'job.status_changed' ELSE 'action.status_changed' END;
      phase := CASE NEW.status WHEN 'submitted' THEN 'queued' ELSE NEW.status END;
    END IF;
    payload := jsonb_build_object(
      'id', resource->'id', 'farmId', NEW.farm_id, 'printerId', printer, 'status', phase,
      'createdAt', resource->'created_at',
      'updatedAt', greatest((resource->>'updated_at')::bigint, (receipt->>'updated_at')::bigint),
      'refusal', CASE WHEN receipt->>'refusal_code' IS NOT NULL THEN jsonb_build_object(
        'code', receipt->'refusal_code', 'detail', nullif(receipt->>'result_detail', '')
      ) END
    );
    IF event_type = 'job.status_changed' THEN
      payload := payload || jsonb_build_object(
        'displayName', resource->'display_name', 'fileUrl', resource->'file_url',
        'sha256', resource->'sha256', 'sizeBytes', resource->'size_bytes',
        'historyEntryId', receipt->'history_entry_id'
      );
    ELSE
      payload := payload || jsonb_build_object(
        'action', resource#>'{action,action}',
        'args', CASE resource#>>'{action,action}' WHEN 'set_temperature' THEN jsonb_build_object(
          'heater', resource#>'{action,args,heater}', 'targetCelsius', resource#>'{action,args,target_c}'
        ) ELSE resource#>'{action,args}' END
      );
    END IF;
  END IF;

  event_uuid := gen_random_uuid();
  INSERT INTO farm.integration_webhook_outbox (subscription_id, event_id, farm_id, printer_id, body)
  SELECT w.id, event_uuid, NEW.farm_id, printer, jsonb_build_object(
    'id', event_uuid, 'type', event_type, 'occurredAt', floor(extract(epoch FROM clock_timestamp()) * 1000),
    'data', jsonb_strip_nulls(payload)
  )
  FROM farm.integration_webhooks w
  WHERE (owner_app IS NULL OR w.app_id = owner_app) AND event_type = ANY(w.events)
    AND farm.integration_webhook_allowed(w.app_id, NEW.farm_id, printer);
  RETURN NULL;
END
$$;
