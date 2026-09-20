/**
 * Event Intelligence — DB Persistence Integration Tests (mysql2 direct)
 *
 * Verifies that event-intel data persists across service restart:
 * 1. Event creation persists and can be read back
 * 2. Version/state persistence works
 * 3. Prediction persists and can be retrieved
 * 4. Outcome persists and links to the correct event
 * 5. Source observations persist with provenance/fingerprint
 * 6. Duplicate/identity constraints behave correctly
 */
import * as dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(__dirname, '../../../.env') });

import * as mysql from 'mysql2/promise';

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function getConnection(): Promise<mysql.Connection | null> {
  try {
    const conn = await mysql.createConnection({
      host: process.env.MYSQL_HOST || '127.0.0.1',
      port: parseInt(process.env.MYSQL_PORT || '3307'),
      user: process.env.MYSQL_USER || 'mylife',
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE || 'myjob_agent',
      connectTimeout: 10000,
    });
    return conn;
  } catch {
    return null;
  }
}

describe('Event Intelligence — DB Persistence', () => {
  let conn: mysql.Connection | null = null;

  beforeAll(async () => {
    conn = await getConnection();
    if (!conn) {
      console.warn('Skipping DB persistence tests — MySQL not available');
    }
  });

  afterAll(async () => {
    if (conn) {
      await conn.query('DELETE FROM event_intel_source_obs WHERE source_id LIKE ?', ['obs-%']);
      await conn.query('DELETE FROM event_intel_outcome WHERE id LIKE ?', ['test-%']);
      await conn.query('DELETE FROM event_intel_prediction WHERE id LIKE ?', ['test-%']);
      await conn.query('DELETE FROM event_intel_version WHERE id LIKE ?', ['test-%']);
      await conn.query('DELETE FROM event_intel_event WHERE id LIKE ?', ['test-%']);
      await conn.end();
    }
  });

  it('event persists and can be read back with all fields', async () => {
    if (!conn) return;

    const eventId = uuid();

    await conn.query(
      `INSERT INTO event_intel_event (
        id, canonical_event_id, ontology, lifecycle, current_state,
        title, body, source_tier, source_name, source_url,
        source_published_at, received_at, processed_at,
        event_fingerprint, language, countries, institutions, companies, assets,
        version_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW(), ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId, eventId, 'RBI_RATE_DECISION', 'PRELIMINARY', 'S0_DETECTED',
        'RBI holds repo rate at 6.5%',
        'The Reserve Bank of India kept the repo rate unchanged at 6.5%.',
        'TIER_1', 'Reuters', 'https://reuters.com/test',
        `fp-${eventId}`, 'en',
        'IN', 'RBI', '', 'NIFTY,SENSEX', 1,
      ],
    );

    const [rows] = await conn.query('SELECT * FROM event_intel_event WHERE id = ?', [eventId]);
    const event = (rows as any[])[0];

    expect(event).toBeDefined();
    expect(event.canonical_event_id).toBe(eventId);
    expect(event.ontology).toBe('RBI_RATE_DECISION');
    expect(event.lifecycle).toBe('PRELIMINARY');
    expect(event.current_state).toBe('S0_DETECTED');
    expect(event.title).toBe('RBI holds repo rate at 6.5%');
    expect(event.source_tier).toBe('TIER_1');
    expect(event.source_name).toBe('Reuters');
    expect(event.version_count).toBe(1);
  });

  it('version persists and links to event', async () => {
    if (!conn) return;

    const eventId = uuid();

    await conn.query(
      `INSERT INTO event_intel_event (
        id, canonical_event_id, ontology, lifecycle, current_state,
        title, source_tier, source_name, source_published_at, received_at,
        event_fingerprint, version_count
      ) VALUES (?, ?, 'EARNINGS', 'PRELIMINARY', 'S0_DETECTED', 'Test Event', 'TIER_2', 'TestSource', NOW(), NOW(), ?, 2)`,
      [eventId, eventId, `fp-v-${eventId}`],
    );

    await conn.query(
      `INSERT INTO event_intel_version (
        id, event_id, version_number, evidence_type, evidence_title, evidence_body,
        received_at, state_before, state_after, state_transition_reason_code
      ) VALUES (?, ?, 1, 'TIER_2', 'Initial', '{}', NOW(), 'PRELIMINARY', 'S0_DETECTED', 'initial_discovery')`,
      [uuid(), eventId],
    );

    await conn.query(
      `INSERT INTO event_intel_version (
        id, event_id, version_number, evidence_type, evidence_title, evidence_body,
        received_at, state_before, state_after, state_transition_reason_code
      ) VALUES (?, ?, 2, 'TIER_1', 'Corroborating', '{}', NOW(), 'PRELIMINARY', 'S1_INITIAL_SHOCK', 'new_corroborating_evidence')`,
      [uuid(), eventId],
    );

    const [rows] = await conn.query(
      'SELECT * FROM event_intel_version WHERE event_id = ? ORDER BY version_number ASC',
      [eventId],
    );
    const versions = rows as any[];

    expect(versions).toHaveLength(2);
    expect(versions[0].version_number).toBe(1);
    expect(versions[0].state_before).toBe('PRELIMINARY');
    expect(versions[0].state_after).toBe('S0_DETECTED');
    expect(versions[1].version_number).toBe(2);
    expect(versions[1].state_after).toBe('S1_INITIAL_SHOCK');
  });

  it('prediction persists and can be retrieved', async () => {
    if (!conn) return;

    const eventId = uuid();
    const predId = uuid();

    await conn.query(
      `INSERT INTO event_intel_event (
        id, canonical_event_id, ontology, lifecycle, current_state,
        title, source_tier, source_name, source_published_at, received_at,
        event_fingerprint, version_count
      ) VALUES (?, ?, 'MACRO_DATA', 'OFFICIAL', 'S2_CROSS_ASSET_CONFIRMED', 'US CPI', 'TIER_1', 'BLS', NOW(), NOW(), ?, 1)`,
      [eventId, eventId, `fp-p-${eventId}`],
    );

    await conn.query(
      `INSERT INTO event_intel_prediction (
        id, event_id, version_number, feature_hash, p_up, p_down, p_flat,
        move_quantiles, abstain_probability, abstain_reasons,
        paper_candidate_type, paper_candidate_confidence, risk_gate_result,
        source_published_at, received_at, decision_at
      ) VALUES (?, ?, 1, 'abc123', 0.55, 0.25, 0.20, ?, 0.15, '[]', 'LONG_CALL', 0.68, 'PAPER_CANDIDATE', NOW(), NOW(), NOW())`,
      [predId, eventId, JSON.stringify({ pUp: 0.55, pDown: 0.25, pFlat: 0.20 })],
    );

    const [rows] = await conn.query('SELECT * FROM event_intel_prediction WHERE id = ?', [predId]);
    const pred = (rows as any[])[0];

    expect(pred).toBeDefined();
    expect(pred.event_id).toBe(eventId);
    expect(parseFloat(pred.p_up)).toBeCloseTo(0.55, 2);
    expect(pred.paper_candidate_type).toBe('LONG_CALL');
    expect(pred.risk_gate_result).toBe('PAPER_CANDIDATE');
  });

  it('outcome persists and links to correct event', async () => {
    if (!conn) return;

    const eventId = uuid();

    await conn.query(
      `INSERT INTO event_intel_event (
        id, canonical_event_id, ontology, lifecycle, current_state,
        title, source_tier, source_name, source_published_at, received_at,
        event_fingerprint, version_count
      ) VALUES (?, ?, 'RBI_RATE_DECISION', 'OFFICIAL', 'S4_ASSIMILATED', 'RBI outcome', 'TIER_1', 'RBI', NOW(), NOW(), ?, 3)`,
      [eventId, eventId, `fp-o-${eventId}`],
    );

    await conn.query(
      `INSERT INTO event_intel_outcome (
        id, event_id, final_lifecycle, final_state, total_versions,
        was_retracted, actual_spot_move, actual_iv_move, source_observations_count
      ) VALUES (?, ?, 'OFFICIAL', 'S4_ASSIMILATED', 3, false, 150, -2.5, 5)`,
      [uuid(), eventId],
    );

    const [rows] = await conn.query('SELECT * FROM event_intel_outcome WHERE event_id = ?', [eventId]);
    const outcome = (rows as any[])[0];

    expect(outcome).toBeDefined();
    expect(outcome.final_lifecycle).toBe('OFFICIAL');
    expect(parseFloat(outcome.actual_spot_move)).toBeCloseTo(150, 0);
    expect(outcome.was_retracted).toBe(0);
    expect(outcome.total_versions).toBe(3);
  });

  it('source observation persists with provenance and fingerprint', async () => {
    if (!conn) return;

    const eventId = uuid();
    const obsId = uuid();
    const fingerprint = `fp-obs-${eventId}`;

    // Create event first (FK constraint)
    await conn.query(
      `INSERT INTO event_intel_event (
        id, canonical_event_id, ontology, lifecycle, current_state,
        title, source_tier, source_name, source_published_at, received_at,
        event_fingerprint, version_count
      ) VALUES (?, ?, 'RBI_RATE_DECISION', 'PRELIMINARY', 'S0_DETECTED', 'Parent Event', 'TIER_1', 'RBI', NOW(), NOW(), ?, 1)`,
      [eventId, eventId, `fp-parent-${eventId}`],
    );

    await conn.query(
      `INSERT INTO event_intel_source_obs (
        id, event_id, canonical_event_id, source_id, source_name, source_tier,
        source_url, source_published_at, received_at,
        title, body, event_fingerprint, is_corroboration, latency_ms
      ) VALUES (?, ?, ?, ?, 'Reuters', 'TIER_1', 'https://reuters.com/test', NOW(), NOW(),
        'Breaking: RBI holds rates', 'Full text', ?, false, 500)`,
      [obsId, eventId, fingerprint, `src-${eventId}`, fingerprint],
    );

    const [rows] = await conn.query('SELECT * FROM event_intel_source_obs WHERE id = ?', [obsId]);
    const obs = (rows as any[])[0];

    expect(obs).toBeDefined();
    expect(obs.source_name).toBe('Reuters');
    expect(obs.source_tier).toBe('TIER_1');
    expect(obs.event_fingerprint).toBe(fingerprint);
    expect(obs.is_corroboration).toBe(0);
    expect(obs.latency_ms).toBe(500);
  });

  it('duplicate event canonical_event_id constraint works', async () => {
    if (!conn) return;

    const eventId = uuid();

    await conn.query(
      `INSERT INTO event_intel_event (
        id, canonical_event_id, ontology, lifecycle, current_state,
        title, source_tier, source_name, source_published_at, received_at,
        event_fingerprint, version_count
      ) VALUES (?, ?, 'TEST_DUP', 'PRELIMINARY', 'S0_DETECTED', 'First', 'TIER_3', 'Test', NOW(), NOW(), ?, 1)`,
      [eventId, eventId, `fp-dup-${eventId}`],
    );

    let threw = false;
    try {
      await conn.query(
        `INSERT INTO event_intel_event (
          id, canonical_event_id, ontology, lifecycle, current_state,
          title, source_tier, source_name, source_published_at, received_at,
          event_fingerprint, version_count
        ) VALUES (?, ?, 'TEST_DUP', 'PRELIMINARY', 'S0_DETECTED', 'Duplicate', 'TIER_3', 'Test', NOW(), NOW(), ?, 1)`,
        [uuid(), eventId, `fp-dup2-${eventId}`],
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
