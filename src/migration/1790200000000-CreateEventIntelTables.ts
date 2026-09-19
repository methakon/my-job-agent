import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateEventIntelTables1790200000000 implements MigrationInterface {
  name = 'CreateEventIntelTables1790200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── event_intel_event ──────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE event_intel_event (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        canonical_event_id    VARCHAR(128) NOT NULL,
        ontology              VARCHAR(32)  NOT NULL,
        lifecycle             VARCHAR(24)  NOT NULL,
        current_state         VARCHAR(48)  NOT NULL,
        title                 VARCHAR(512) NOT NULL,
        body                  TEXT,
        source_tier           VARCHAR(32)  NOT NULL,
        source_name           VARCHAR(128) NOT NULL,
        source_url            TEXT,
        source_published_at   TIMESTAMPTZ  NOT NULL,
        source_updated_at     TIMESTAMPTZ,
        received_at           TIMESTAMPTZ  NOT NULL,
        processed_at          TIMESTAMPTZ,
        event_fingerprint     VARCHAR(128) NOT NULL,
        raw_payload_hash      VARCHAR(128),
        language              VARCHAR(8)   NOT NULL DEFAULT 'en',
        countries             VARCHAR[],
        institutions          VARCHAR[],
        companies             VARCHAR[],
        assets                VARCHAR[],
        event_type            VARCHAR(64),
        event_subtype         VARCHAR(64),
        scheduled_time        TIMESTAMPTZ,
        scheduled_timezone    VARCHAR(32),
        importance            INT,
        surprise_raw          NUMERIC(10,6),
        surprise_standardized NUMERIC(10,6),
        surprise_percentile   NUMERIC(5,2),
        novelty_score         NUMERIC(5,4),
        version_count         INT NOT NULL DEFAULT 1,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
        id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id                  UUID         NOT NULL REFERENCES event_intel_event(id),
        version_number            INT          NOT NULL,
        evidence_type             VARCHAR(32)  NOT NULL,
        evidence_title            TEXT,
        evidence_body             TEXT,
        evidence_source           VARCHAR(128),
        evidence_source_url       TEXT,
        evidence_published_at     TIMESTAMPTZ,
        received_at               TIMESTAMPTZ  NOT NULL,
        state_before              VARCHAR(48),
        state_after               VARCHAR(48),
        state_transition_reason_code VARCHAR(64),
        feature_hash              VARCHAR(128),
        frozen_prediction_id      UUID,
        created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
        id                                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id                              UUID         NOT NULL REFERENCES event_intel_event(id),
        version_number                        INT          NOT NULL,
        feature_hash                          VARCHAR(128) NOT NULL,
        p_up                                  NUMERIC(6,4),
        p_down                                NUMERIC(6,4),
        p_flat                                NUMERIC(6,4),
        move_quantiles                        TEXT,
        iv_crush_probability                  NUMERIC(6,4),
        skew_change_distribution              TEXT,
        term_structure_change_distribution    TEXT,
        liquidity_stress_probability          NUMERIC(6,4),
        abstain_probability                   NUMERIC(6,4),
        abstain_reasons                       VARCHAR[],
        paper_candidate_type                  VARCHAR(32),
        paper_candidate_strike                NUMERIC(12,2),
        paper_candidate_expiry                VARCHAR(16),
        paper_candidate_confidence            NUMERIC(6,4),
        risk_gate_result                      VARCHAR(16),
        risk_gate_rejection_reason            TEXT,
        source_published_at                   TIMESTAMPTZ  NOT NULL,
        received_at                           TIMESTAMPTZ  NOT NULL,
        normalized_at                         TIMESTAMPTZ,
        verified_at                           TIMESTAMPTZ,
        feature_at                            TIMESTAMPTZ,
        forecast_at                           TIMESTAMPTZ,
        decision_at                           TIMESTAMPTZ  NOT NULL,
        created_at                            TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
        id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id                 UUID         NOT NULL REFERENCES event_intel_event(id),
        final_lifecycle          VARCHAR(24)  NOT NULL,
        final_state              VARCHAR(48)  NOT NULL,
        total_versions           INT          NOT NULL,
        was_retracted            BOOLEAN      NOT NULL DEFAULT FALSE,
        actual_spot_move         NUMERIC(12,4),
        actual_iv_move           NUMERIC(10,4),
        prediction_accuracy      NUMERIC(6,4),
        counterfactual_no_event  TEXT,
        error_attribution        TEXT,
        source_observations_count INT NOT NULL DEFAULT 0,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_outcome_event_id
        ON event_intel_outcome (event_id)
    `);

    // ── event_intel_source_obs ─────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE event_intel_source_obs (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id            UUID         NOT NULL REFERENCES event_intel_event(id),
        canonical_event_id  VARCHAR(128) NOT NULL,
        source_id           VARCHAR(256) NOT NULL,
        source_name         VARCHAR(128) NOT NULL,
        source_tier         VARCHAR(32)  NOT NULL,
        source_url          TEXT,
        source_published_at TIMESTAMPTZ  NOT NULL,
        source_updated_at   TIMESTAMPTZ,
        received_at         TIMESTAMPTZ  NOT NULL,
        processed_at        TIMESTAMPTZ,
        title               TEXT         NOT NULL,
        body                TEXT,
        source_type         VARCHAR(64),
        language            VARCHAR(8),
        raw_payload_hash    VARCHAR(128),
        event_fingerprint   VARCHAR(128) NOT NULL,
        is_corroboration    BOOLEAN      NOT NULL DEFAULT FALSE,
        latency_ms          INT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
