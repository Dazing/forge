-- Phase 0 initial schema (design §7.2).
-- All *_at timestamps are UTC RFC 3339 TEXT. Foreign keys are enforced.
-- Payloads/transcripts are bounded: the database stores references to large
-- artifacts (artifact_url, report_url), never their bodies. No transcript or
-- log columns exist.

CREATE TABLE IF NOT EXISTS webhook_delivery (
    delivery_id      TEXT    NOT NULL PRIMARY KEY,
    event            TEXT    NOT NULL,
    project_id       INTEGER NOT NULL,
    received_at      TEXT    NOT NULL,
    payload_sha256   TEXT    NOT NULL,
    payload_json     TEXT    NOT NULL,
    state            TEXT    NOT NULL DEFAULT 'received',
    attempts         INTEGER NOT NULL DEFAULT 0,
    error            TEXT,
    created_at       TEXT    NOT NULL,
    updated_at       TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS project (
    gitlab_id             INTEGER NOT NULL PRIMARY KEY,
    path                  TEXT    NOT NULL UNIQUE,
    enabled               INTEGER NOT NULL DEFAULT 1,
    default_branch        TEXT    NOT NULL DEFAULT 'main',
    webhook_mode          TEXT    NOT NULL DEFAULT 'signed',
    last_full_reconciled_at TEXT,
    created_at            TEXT    NOT NULL,
    updated_at            TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS work_item (
    project_id       INTEGER NOT NULL,
    issue_iid        INTEGER NOT NULL,
    issue_id         INTEGER,
    gitlab_updated_at TEXT,
    desired_state    TEXT,
    observed_state   TEXT,
    priority_rank    INTEGER,
    active_mr_iid    INTEGER,
    base_sha         TEXT,
    terminal_reason  TEXT,
    created_at       TEXT    NOT NULL,
    updated_at       TEXT    NOT NULL,
    PRIMARY KEY (project_id, issue_iid),
    FOREIGN KEY (project_id) REFERENCES project(gitlab_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dependency (
    project_id       INTEGER NOT NULL,
    issue_iid        INTEGER NOT NULL,
    dep_project_id   INTEGER NOT NULL,
    dep_issue_iid    INTEGER NOT NULL,
    source           TEXT    NOT NULL CHECK (source IN ('api', 'description')),
    satisfied        INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL,
    updated_at       TEXT    NOT NULL,
    PRIMARY KEY (project_id, issue_iid, dep_project_id, dep_issue_iid, source),
    FOREIGN KEY (project_id, issue_iid)
        REFERENCES work_item(project_id, issue_iid) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS plan (
    project_id       INTEGER NOT NULL,
    issue_iid        INTEGER NOT NULL,
    run_id           TEXT    NOT NULL,
    base_sha         TEXT,
    plan_json        TEXT    NOT NULL,
    expected_paths   TEXT,
    risk_flags       TEXT,
    ambiguities      TEXT,
    created_at       TEXT    NOT NULL,
    updated_at       TEXT    NOT NULL,
    PRIMARY KEY (project_id, issue_iid, run_id),
    FOREIGN KEY (project_id, issue_iid)
        REFERENCES work_item(project_id, issue_iid) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS run (
    run_id           TEXT    NOT NULL PRIMARY KEY,
    project_id       INTEGER NOT NULL,
    issue_iid        INTEGER NOT NULL,
    role             TEXT    NOT NULL,
    harness_revision TEXT,
    model_revision   TEXT,
    config_revision  TEXT,
    status           TEXT    NOT NULL,
    worker_job_id    TEXT,
    input_sha        TEXT,
    base_sha         TEXT,
    head_sha         TEXT,
    repair_cycle     INTEGER NOT NULL DEFAULT 0,
    started_at       TEXT,
    heartbeat_at     TEXT,
    finished_at      TEXT,
    exit_class       TEXT,
    artifact_url     TEXT,
    created_at       TEXT    NOT NULL,
    updated_at       TEXT    NOT NULL,
    FOREIGN KEY (project_id, issue_iid)
        REFERENCES work_item(project_id, issue_iid) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_run_work_item ON run(project_id, issue_iid);

CREATE TABLE IF NOT EXISTS merge_request (
    project_id            INTEGER NOT NULL,
    mr_iid                INTEGER NOT NULL,
    source_branch         TEXT,
    target_branch         TEXT,
    head_sha              TEXT,
    pipeline_id           INTEGER,
    pipeline_status       TEXT,
    merge_status          TEXT,
    last_synchronized_at  TEXT,
    created_at            TEXT    NOT NULL,
    updated_at            TEXT    NOT NULL,
    PRIMARY KEY (project_id, mr_iid),
    FOREIGN KEY (project_id) REFERENCES project(gitlab_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS review (
    project_id    INTEGER NOT NULL,
    mr_iid        INTEGER NOT NULL,
    reviewed_sha  TEXT    NOT NULL,
    reviewer_run  TEXT,
    verdict       TEXT    NOT NULL,
    report_url    TEXT,
    created_at    TEXT    NOT NULL,
    valid         INTEGER NOT NULL DEFAULT 1,
    updated_at    TEXT    NOT NULL,
    PRIMARY KEY (project_id, mr_iid, reviewed_sha),
    FOREIGN KEY (project_id, mr_iid)
        REFERENCES merge_request(project_id, mr_iid) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lease (
    kind               TEXT NOT NULL
        CHECK (kind IN ('implementation-slot', 'review-slot', 'work-item', 'conflict')),
    key                TEXT NOT NULL,
    owner_run_id       TEXT,
    owner_project_id   INTEGER,
    owner_issue_iid    INTEGER,
    acquired_at        TEXT NOT NULL,
    heartbeat_at       TEXT,
    expires_at         TEXT NOT NULL,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    PRIMARY KEY (kind, key)
);

CREATE TABLE IF NOT EXISTS transition (
    id              INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    project_id      INTEGER NOT NULL,
    issue_iid       INTEGER NOT NULL,
    from_state      TEXT,
    to_state        TEXT    NOT NULL,
    reason          TEXT,
    gitlab_event    TEXT,
    delivery_id     TEXT,
    actor           TEXT,
    created_at      TEXT    NOT NULL,
    FOREIGN KEY (project_id, issue_iid)
        REFERENCES work_item(project_id, issue_iid) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_transition_work_item ON transition(project_id, issue_iid);

CREATE TABLE IF NOT EXISTS action (
    idempotency_key   TEXT    NOT NULL PRIMARY KEY,
    action_type       TEXT    NOT NULL,
    target            TEXT    NOT NULL,
    request_hash      TEXT    NOT NULL,
    state             TEXT    NOT NULL,
    remote_result_id  TEXT,
    attempts          INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT    NOT NULL,
    updated_at        TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_state ON action(state);

CREATE TABLE IF NOT EXISTS release_candidate (
    project_id                 INTEGER NOT NULL,
    release_ref                TEXT    NOT NULL,
    commit_sha                 TEXT,
    image_digest               TEXT,
    qualification_pipeline_id  INTEGER,
    qualification_status       TEXT,
    test_deployment_id         INTEGER,
    gate_statuses              TEXT,
    report_url                 TEXT,
    production_deployment_id   INTEGER,
    created_at                 TEXT    NOT NULL,
    updated_at                 TEXT    NOT NULL,
    PRIMARY KEY (project_id, release_ref),
    FOREIGN KEY (project_id) REFERENCES project(gitlab_id) ON DELETE CASCADE
);
