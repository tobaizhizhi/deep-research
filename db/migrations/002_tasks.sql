CREATE TABLE research_tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id),
    question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 4000),
    requirements text NOT NULL DEFAULT '' CHECK (char_length(requirements) <= 2000),
    language text NOT NULL CHECK (language IN ('auto', 'zh', 'en')),
    depth text NOT NULL CHECK (depth IN ('quick', 'standard')),
    config_json jsonb NOT NULL CHECK (jsonb_typeof(config_json) = 'object'),
    status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    current_attempt_id uuid,
    research_done boolean NOT NULL DEFAULT false,
    stop_reason text NOT NULL DEFAULT '',
    cancel_requested_at timestamptz,
    next_event_seq bigint NOT NULL DEFAULT 1 CHECK (next_event_seq > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id)
);
CREATE INDEX research_tasks_owner_idx ON research_tasks (user_id, created_at DESC, id DESC);

CREATE TABLE research_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL REFERENCES research_tasks(id),
    number integer NOT NULL CHECK (number > 0),
    status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'abandoned')),
    worker_id text,
    lease_token uuid,
    lease_expires_at timestamptz,
    heartbeat_at timestamptz,
    started_at timestamptz,
    finished_at timestamptz,
    error_code text,
    error_detail text,
    versions_json jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(versions_json) = 'object'),
    UNIQUE (task_id, number),
    UNIQUE (task_id, id)
);
ALTER TABLE research_tasks ADD CONSTRAINT current_attempt_belongs_to_task
    FOREIGN KEY (id, current_attempt_id) REFERENCES research_attempts(task_id, id);

CREATE TABLE task_outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL REFERENCES research_tasks(id),
    attempt_id uuid NOT NULL,
    schema_version integer NOT NULL CHECK (schema_version > 0),
    payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'publishing', 'published')),
    claim_token uuid,
    claim_until timestamptz,
    publish_attempts integer NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
    next_publish_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    FOREIGN KEY (task_id, attempt_id) REFERENCES research_attempts(task_id, id),
    UNIQUE (attempt_id, schema_version)
);
CREATE INDEX task_outbox_pending_idx ON task_outbox (next_publish_at) WHERE state <> 'published';

CREATE TABLE task_events (
    task_id uuid NOT NULL REFERENCES research_tasks(id),
    seq bigint NOT NULL CHECK (seq > 0),
    attempt_id uuid,
    type text NOT NULL,
    payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, seq),
    FOREIGN KEY (task_id, attempt_id) REFERENCES research_attempts(task_id, id)
);

CREATE TABLE api_idempotency (
    user_id uuid NOT NULL REFERENCES users(id),
    operation text NOT NULL,
    key text NOT NULL,
    request_hash text NOT NULL,
    resource_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (user_id, operation, key),
    FOREIGN KEY (user_id, resource_id) REFERENCES research_tasks(user_id, id),
    CHECK (expires_at > created_at)
);

-- 防止后续更新状态时顺手改掉历史输入或运行配置。
CREATE FUNCTION protect_task_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.user_id, NEW.question, NEW.requirements, NEW.language, NEW.depth, NEW.config_json)
       IS DISTINCT FROM
       ROW(OLD.user_id, OLD.question, OLD.requirements, OLD.language, OLD.depth, OLD.config_json) THEN
        RAISE EXCEPTION 'task input and configuration are immutable' USING ERRCODE = '23514';
    END IF;
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;
CREATE TRIGGER freeze_task_snapshot BEFORE UPDATE ON research_tasks
    FOR EACH ROW EXECUTE FUNCTION protect_task_snapshot();
