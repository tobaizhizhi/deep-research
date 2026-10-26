-- P8：人工复核、用户反馈和追加式操作历史。
CREATE TABLE user_roles (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('reviewer', 'dispatcher')),
    granted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, role)
);

ALTER TABLE research_tasks
    ADD COLUMN parent_report_id uuid,
    ADD COLUMN review_id uuid;

ALTER TABLE api_idempotency
    ADD COLUMN result_review_id uuid,
    ADD COLUMN result_feedback_id uuid;

CREATE TABLE report_reviews (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id uuid NOT NULL REFERENCES research_reports(id),
    task_id uuid NOT NULL,
    requested_by uuid NOT NULL REFERENCES users(id),
    assigned_to uuid REFERENCES users(id),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_review', 'completed', 'cancelled')),
    reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
    verdict text CHECK (verdict IN ('confirmed', 'needs_more_evidence', 'not_accepted')),
    notes_json jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(notes_json) = 'object'),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    FOREIGN KEY (task_id) REFERENCES research_tasks(id) ON DELETE CASCADE,
    CHECK ((status = 'completed') = (verdict IS NOT NULL)),
    CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);

ALTER TABLE api_idempotency
    ADD CONSTRAINT api_idempotency_result_review_fk
    FOREIGN KEY (result_review_id) REFERENCES report_reviews(id);

CREATE INDEX report_reviews_requested_idx
    ON report_reviews (requested_by, created_at DESC);
CREATE INDEX report_reviews_assigned_idx
    ON report_reviews (assigned_to, status, created_at DESC);
CREATE UNIQUE INDEX report_reviews_one_open_idx
    ON report_reviews (report_id)
    WHERE status IN ('pending', 'in_review');

CREATE TABLE report_feedback (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id uuid NOT NULL REFERENCES research_reports(id),
    task_id uuid NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feedback_text text NOT NULL CHECK (length(btrim(feedback_text)) BETWEEN 1 AND 4000),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX report_feedback_report_idx ON report_feedback (report_id, created_at DESC);

CREATE TABLE report_evaluations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id uuid NOT NULL REFERENCES research_reports(id) ON DELETE CASCADE,
    evaluation_version text NOT NULL CHECK (length(btrim(evaluation_version)) BETWEEN 1 AND 100),
    code_version text NOT NULL CHECK (length(btrim(code_version)) BETWEEN 1 AND 100),
    prompt_version text NOT NULL CHECK (length(btrim(prompt_version)) BETWEEN 1 AND 100),
    model_version text NOT NULL CHECK (length(btrim(model_version)) BETWEEN 1 AND 200),
    budget_json jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(budget_json) = 'object'),
    usage_json jsonb NOT NULL DEFAULT '{"status":"unavailable"}' CHECK (jsonb_typeof(usage_json) = 'object'),
    cost_json jsonb NOT NULL DEFAULT '{"status":"unavailable"}' CHECK (jsonb_typeof(cost_json) = 'object'),
    result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX report_evaluations_report_idx ON report_evaluations (report_id, created_at DESC);

ALTER TABLE api_idempotency
    ADD CONSTRAINT api_idempotency_result_feedback_fk
    FOREIGN KEY (result_feedback_id) REFERENCES report_feedback(id);

-- 分派人员和 reviewer 不是任务所有者，不能复用带 owner 外键的 api_idempotency。
CREATE TABLE review_idempotency (
    actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation text NOT NULL,
    key text NOT NULL,
    request_hash text NOT NULL,
    task_id uuid NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
    review_id uuid REFERENCES report_reviews(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (actor_id, operation, key),
    CHECK (expires_at > created_at)
);

CREATE TABLE review_actions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id uuid NOT NULL REFERENCES report_reviews(id) ON DELETE CASCADE,
    actor_id uuid NOT NULL REFERENCES users(id),
    action text NOT NULL CHECK (action IN ('requested', 'assigned', 'decision', 'cancelled')),
    from_status text,
    to_status text,
    from_version integer NOT NULL CHECK (from_version > 0),
    to_version integer NOT NULL CHECK (to_version > 0),
    details_json jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details_json) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_actions_review_idx ON review_actions (review_id, created_at, id);

ALTER TABLE research_tasks
    ADD CONSTRAINT research_tasks_parent_report_fk
    FOREIGN KEY (parent_report_id) REFERENCES research_reports(id),
    ADD CONSTRAINT research_tasks_review_fk
    FOREIGN KEY (review_id) REFERENCES report_reviews(id);
CREATE INDEX research_tasks_parent_report_idx ON research_tasks (parent_report_id);

CREATE FUNCTION touch_review_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;
CREATE TRIGGER report_reviews_touch BEFORE UPDATE ON report_reviews
    FOR EACH ROW EXECUTE FUNCTION touch_review_updated_at();
