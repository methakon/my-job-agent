import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateEventIntelTables1790200000000 implements MigrationInterface {
  name = 'CreateEventIntelTables1790200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── event_intel_event ──────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE event_intel_event (
        id                    VARCHAR(36) PRIMARY KEY,
        canonical_event_id    VARCHAR(128) NOT NULL,
        ontology              VARCHAR(32)  NOT NULL,
        lifecycle             VARCHAR(24)  NOT NULL,
        current_state         VARCHAR(48)  NOT NULL,
        title                 VARCHAR(512) NOT NULL,
        body                  TEXT,
        source_tier           VARCHAR(32)  NOT NULL,
        source_name           VARCHAR(128) NOT NULL,
        source_url            TEXT,
        source_published_at   DATETIME(6)  NOT NULL,
        source_updated_at     DATETIME(6),
        received_at           DATETIME(6)  NOT NULL,
        processed_at          DATETIME(6),
        event_fingerprint     VARCHAR(128) NOT NULL,
        raw_payload_hash      VARCHAR(128),
        language              VARCHAR(8)   NOT NULL DEFAULT 'en',
        countries             TEXT,
        institutions          TEXT,
        companies             TEXT,
        assets                TEXT,
        event_type            VARCHAR(64),
        event_subtype         VARCHAR(64),
        scheduled_time        DATETIME(6),
        scheduled_timezone    VARCHAR(32),
        importance            INT,
        surprise_raw          DECIMAL(10,6),
        surprise_standardized DECIMAL(10,6),
        surprise_percentile   DECIMAL(5,2),
        novelty_score         DECIMAL(5,4),
        version_count         INT NOT NULL DEFAULT 1,
        created_at            DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at            DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_event_canonical_id
        ON event_intel_event (canonical_event_id)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_event_state
        ON event_intel_event (current_state)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_event_ontology
        ON event_intel_event (ontology)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_event_received_at
        ON event_intel_event (received_at)
    `);

    // ── event_intel_version ────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE event_intel_version (
        id                        VARCHAR(36) PRIMARY KEY,
        event_id                  VARCHAR(36)  NOT NULL,
        version_number            INT          NOT NULL,
        evidence_type             VARCHAR(32)  NOT NULL,
        evidence_title            TEXT,
        evidence_body             TEXT,
        evidence_source           VARCHAR(128),
        evidence_source_url       TEXT,
        evidence_published_at     DATETIME(6),
        received_at               DATETIME(6)  NOT NULL,
        state_before              VARCHAR(48),
        state_after               VARCHAR(48),
        state_transition_reason_code VARCHAR(64),
        feature_hash              VARCHAR(128),
        frozen_prediction_id      VARCHAR(36),
        created_at                DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        CONSTRAINT fk_version_event FOREIGN KEY (event_id) REFERENCES event_intel_event(id)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_version_event_id
        ON event_intel_version (event_id)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_version_event_num
        ON event_intel_version (event_id, version_number)
    `);

    // ── event_intel_prediction ─────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE event_intel_prediction (
        id                                    VARCHAR(36) PRIMARY KEY,
        event_id                              VARCHAR(36)  NOT NULL,
        version_number                        INT          NOT NULL,
        feature_hash                          VARCHAR(128) NOT NULL,
        p_up                                  DECIMAL(6,4),
        p_down                                DECIMAL(6,4),
        p_flat                                DECIMAL(6,4),
        move_quantiles                        TEXT,
        iv_crush_probability                  DECIMAL(6,4),
        skew_change_distribution              TEXT,
        term_structure_change_distribution    TEXT,
        liquidity_stress_probability          DECIMAL(6,4),
        abstain_probability                   DECIMAL(6,4),
        abstain_reasons                       TEXT,
        paper_candidate_type                  VARCHAR(32),
        paper_candidate_strike                DECIMAL(12,2),
        paper_candidate_expiry                VARCHAR(16),
        paper_candidate_confidence            DECIMAL(6,4),
        risk_gate_result                      VARCHAR(16),
        risk_gate_rejection_reason            TEXT,
        source_published_at                   DATETIME(6)  NOT NULL,
        received_at                           DATETIME(6)  NOT NULL,
        normalized_at                         DATETIME(6),
        verified_at                           DATETIME(6),
        feature_at                            DATETIME(6),
        forecast_at                           DATETIME(6),
        decision_at                           DATETIME(6)  NOT NULL,
        created_at                            DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        CONSTRAINT fk_prediction_event FOREIGN KEY (event_id) REFERENCES event_intel_event(id)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_prediction_event_id
        ON event_intel_prediction (event_id)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_prediction_event_ver
        ON event_intel_prediction (event_id, version_number)
    `);

    // ── event_intel_outcome ────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE event_intel_outcome (
        id                       VARCHAR(36) PRIMARY KEY,
        event_id                 VARCHAR(36)  NOT NULL,
        final_lifecycle          VARCHAR(24)  NOT NULL,
        final_state              VARCHAR(48)  NOT NULL,
        total_versions           INT          NOT NULL,
        was_retracted            TINYINT(1)   NOT NULL DEFAULT 0,
        actual_spot_move         DECIMAL(12,4),
        actual_iv_move           DECIMAL(10,4),
        prediction_accuracy      DECIMAL(6,4),
        counterfactual_no_event  TEXT,
        error_attribution        TEXT,
        source_observations_count INT NOT NULL DEFAULT 0,
        created_at               DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        CONSTRAINT fk_outcome_event FOREIGN KEY (event_id) REFERENCES event_intel_event(id)
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_outcome_event_id
        ON event_intel_outcome (event_id)
    `);

    // ── event_intel_source_obs ─────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE event_intel_source_obs (
        id                  VARCHAR(36) PRIMARY KEY,
        event_id            VARCHAR(36)  NOT NULL,
        canonical_event_id  VARCHAR(128) NOT NULL,
        source_id           VARCHAR(256) NOT NULL,
        source_name         VARCHAR(128) NOT NULL,
        source_tier         VARCHAR(32)  NOT NULL,
        source_url          TEXT,
        source_published_at DATETIME(6)  NOT NULL,
        source_updated_at   DATETIME(6),
        received_at         DATETIME(6)  NOT NULL,
        processed_at        DATETIME(6),
        title               TEXT         NOT NULL,
        body                TEXT,
        source_type         VARCHAR(64),
        language            VARCHAR(8),
        raw_payload_hash    VARCHAR(128),
        event_fingerprint   VARCHAR(128) NOT NULL,
        is_corroboration    TINYINT(1)   NOT NULL DEFAULT 0,
        latency_ms          INT,
        created_at          DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        CONSTRAINT fk_source_obs_event FOREIGN KEY (event_id) REFERENCES event_intel_event(id)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_source_obs_event_id
        ON event_intel_source_obs (event_id)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_source_obs_canonical_id
        ON event_intel_source_obs (canonical_event_id)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_source_obs_fingerprint
        ON event_intel_source_obs (event_fingerprint)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_source_obs_received_at
        ON event_intel_source_obs (received_at)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS event_intel_source_obs`);
    await queryRunner.query(`DROP TABLE IF EXISTS event_intel_outcome`);
    await queryRunner.query(`DROP TABLE IF EXISTS event_intel_prediction`);
    await queryRunner.query(`DROP TABLE IF EXISTS event_intel_version`);
    await queryRunner.query(`DROP TABLE IF EXISTS event_intel_event`);
  }
}
