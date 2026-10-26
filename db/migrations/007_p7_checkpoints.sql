-- P7：逻辑图运行、稳定 Researcher 子任务和可控接续。
-- LangGraph 自己的 checkpoint_* 表由独立初始化步骤建立，业务迁移只保存身份、版本和结果。
CREATE TABLE research_graph_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
    run_number integer NOT NULL CHECK (run_number > 0),
    thread_id text NOT NULL UNIQUE,
    checkpoint_ns text NOT NULL DEFAULT '',
    graph_mode text NOT NULL DEFAULT 'fixed' CHECK (graph_mode = 'fixed'),
    state_schema_version integer NOT NULL DEFAULT 1 CHECK (state_schema_version > 0),
    code_version text NOT NULL,
    prompt_version text NOT NULL,
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'completed', 'incompatible')),
    resume_count integer NOT NULL DEFAULT 0 CHECK (resume_count >= 0),
    max_resume_count integer NOT NULL DEFAULT 3 CHECK (max_resume_count >= 0),
    last_checkpoint_at timestamptz,
    checkpoint_count bigint NOT NULL DEFAULT 0 CHECK (checkpoint_count >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (task_id, run_number),
    UNIQUE (id, task_id)
);

-- 现有任务在迁移时获得一个逻辑图运行；旧 attempt 仍可被审计。
INSERT INTO research_graph_runs
    (task_id, run_number, thread_id, code_version, prompt_version)
SELECT t.id, 1, 'research:' || t.id::text,
       COALESCE(t.config_json->>'code_version', 'legacy'),
       COALESCE(t.config_json->>'prompt_version', 'legacy')
FROM research_tasks t;

UPDATE research_graph_runs g SET status='completed'
FROM research_tasks t
WHERE g.task_id=t.id AND t.status='succeeded';

ALTER TABLE research_attempts ADD COLUMN graph_run_id uuid;
ALTER TABLE research_attempts ADD COLUMN resume_from_checkpoint boolean NOT NULL DEFAULT false;
UPDATE research_attempts a
SET graph_run_id = r.id
FROM research_graph_runs r
WHERE r.task_id = a.task_id AND r.run_number = 1;
ALTER TABLE research_attempts ALTER COLUMN graph_run_id SET NOT NULL;
ALTER TABLE research_attempts ADD CONSTRAINT research_attempt_graph_run_id_unique
    UNIQUE (graph_run_id, id);
ALTER TABLE research_attempts
    ADD CONSTRAINT research_attempt_graph_run_fk
    FOREIGN KEY (graph_run_id, task_id) REFERENCES research_graph_runs(id, task_id);

CREATE TABLE research_subtasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    graph_run_id uuid NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal > 0),
    batch integer NOT NULL CHECK (batch > 0),
    researcher_id text NOT NULL,
    topic text NOT NULL CHECK (length(btrim(topic)) > 0),
    thread_id text NOT NULL UNIQUE,
    checkpoint_ns text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    attempt_id uuid,
    result_json jsonb,
    error_detail text,
    started_at timestamptz,
    last_checkpoint_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (graph_run_id) REFERENCES research_graph_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (graph_run_id, attempt_id) REFERENCES research_attempts(graph_run_id, id),
    UNIQUE (graph_run_id, ordinal),
    UNIQUE (graph_run_id, researcher_id),
    CHECK ((status = 'succeeded') = (result_json IS NOT NULL))
);
CREATE INDEX research_subtasks_run_status_idx
    ON research_subtasks (graph_run_id, status, ordinal);

CREATE FUNCTION touch_p7_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;
CREATE TRIGGER research_graph_runs_touch BEFORE UPDATE ON research_graph_runs
    FOR EACH ROW EXECUTE FUNCTION touch_p7_updated_at();
CREATE TRIGGER research_subtasks_touch BEFORE UPDATE ON research_subtasks
    FOR EACH ROW EXECUTE FUNCTION touch_p7_updated_at();
