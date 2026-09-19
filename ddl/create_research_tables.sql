-- research_results: daily research output from off-hours research worker
-- One row per (sessionDate, underlying) pair.
CREATE TABLE IF NOT EXISTS research_results (
  id                    VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  sessionDate           DATE NOT NULL,
  underlying            VARCHAR(20) NOT NULL,
  sampleCount           INT DEFAULT 0,
  metrics               JSON,
  detectedRegime        VARCHAR(50),
  patterns              JSON,
  candidateChanges      JSON,
  baselineMetrics       JSON,
  candidateMetrics      JSON,
  validationStatus      VARCHAR(20) DEFAULT 'PROPOSED',
  researchVersion       INT DEFAULT 1,
  createdAt             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- lookup by date + underlying (latest research for session)
  INDEX idx_research_results_session_underlying (sessionDate, underlying),
  -- filter by validation status
  INDEX idx_research_results_status (validationStatus)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- adaptation_candidates: controlled parameter change candidates
-- Lifecycle: PROPOSED -> VALIDATING -> APPROVED -> ACTIVE -> ROLLED_BACK
--                                 -> REJECTED
CREATE TABLE IF NOT EXISTS adaptation_candidates (
  id                    VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  paramName             VARCHAR(100) NOT NULL,
  paramCategory         VARCHAR(50) NOT NULL,
  oldValue              TEXT NOT NULL,
  proposedValue         TEXT NOT NULL,
  reason                TEXT NOT NULL,
  evidenceIds           JSON,
  baselineMetrics       JSON,
  candidateMetrics      JSON,
  status                VARCHAR(20) DEFAULT 'PROPOSED',
  validationId          VARCHAR(36),
  activatedAt           DATETIME,
  rollbackValue         TEXT,
  researchResultId      VARCHAR(36),
  replacesCandidateId   VARCHAR(36),
  createdAt             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- lookup by lifecycle status
  INDEX idx_adaptation_candidates_status (status),
  -- lookup by parameter name
  INDEX idx_adaptation_candidates_param (paramName),
  -- link to parent research
  INDEX idx_adaptation_candidates_research (researchResultId),
  -- link to previous active candidate
  INDEX idx_adaptation_candidates_replaces (replacesCandidateId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- validation_results: validation evidence for an adaptation candidate
-- A candidate must NOT be activated unless validation passes all gates.
CREATE TABLE IF NOT EXISTS validation_results (
  id                    VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  candidateId           VARCHAR(36) NOT NULL,
  validationType        VARCHAR(50) NOT NULL,
  baselineWinRate       DECIMAL(6,2),
  candidateWinRate      DECIMAL(6,2),
  baselineExpectancy    DECIMAL(10,2),
  candidateExpectancy   DECIMAL(10,2),
  baselineTradeCount    INT DEFAULT 0,
  candidateTradeCount   INT DEFAULT 0,
  maxDrawdown           DECIMAL(8,2),
  stabilityScore        DECIMAL(5,4),
  sampleSize            INT DEFAULT 0,
  inSampleCount         INT DEFAULT 0,
  outOfSampleCount      INT DEFAULT 0,
  regimeAware           BOOLEAN DEFAULT FALSE,
  passed                BOOLEAN DEFAULT FALSE,
  rejectionReason       TEXT,
  evidence              JSON,
  createdAt             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- lookup validation for a candidate
  INDEX idx_validation_results_candidate (candidateId),
  -- filter by pass/fail
  INDEX idx_validation_results_passed (passed)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
