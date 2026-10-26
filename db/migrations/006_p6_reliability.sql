-- P6：为重试幂等保存第一次创建的 attempt，并允许对账重新投递已发布 outbox。
ALTER TABLE api_idempotency
    ADD COLUMN result_attempt_id uuid;

ALTER TABLE api_idempotency
    ADD CONSTRAINT api_idempotency_result_attempt_fk
    FOREIGN KEY (resource_id, result_attempt_id)
    REFERENCES research_attempts(task_id, id);

CREATE INDEX api_idempotency_retry_result_idx
    ON api_idempotency (resource_id, result_attempt_id)
    WHERE operation = 'research.retry';

ALTER TABLE task_outbox
    ADD COLUMN last_reconciled_at timestamptz;

CREATE INDEX task_outbox_reconcile_idx
    ON task_outbox (last_reconciled_at, next_publish_at)
    WHERE state = 'published';
