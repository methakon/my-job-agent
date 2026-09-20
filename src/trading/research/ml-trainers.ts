/**
 * ITEM 163 + 165 — ML trainers: logistic, ridge, calibrated boosting, XGBoost, LightGBM.
 *
 * doneWhen (163): "reviewer can determine behavior."
 * doneWhen (165): "result stored with experiment ID."
 *
 * PURE: no clock, no I/O, no DB, no network, no randomness.
 * RESEARCH / SHADOW ONLY: nothing in production imports this module.
 *
 * These are simplified research-mode implementations of ML trainers.
 * They use basic linear algebra and gradient descent without external ML
 * libraries. The purpose is to validate the training pipeline and
 * demonstrate that models can be trained, evaluated, and stored.
 */

// ── Types ─────────────────────────────────────────────────────────────

export const ML_TRAINERS_VERSION = 'mltrain-v1';

export interface TrainingData {
  /** Feature matrix: rows = samples, cols = features. */
  readonly X: readonly (readonly number[])[];
  /** Labels (binary: 0 or 1). */
  readonly y: readonly number[];
}

export interface TrainResult {
  readonly model: TrainedModel;
  readonly metrics: ModelMetrics;
}

export interface TrainedModel {
  readonly type: string;
  readonly weights: readonly number[];
  readonly bias: number;
  readonly version: string;
}

export interface ModelMetrics {
  readonly accuracy: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly auc: number;
  readonly logLoss: number;
}

// ── Logistic Regression ───────────────────────────────────────────────

/**
 * Train a logistic regression model via gradient descent.
 *
 * This is the simplest baseline classifier. It learns a linear decision
 * boundary in feature space via logistic loss minimization.
 *
 * Deterministic: same inputs + same hyperparameters → same weights, always.
 */
export function trainLogisticRegression(
  data: TrainingData,
  params: { lr?: number; epochs?: number; l2?: number } = {},
): TrainResult {
  const lr = params.lr ?? 0.01;
  const epochs = params.epochs ?? 200;
  const l2 = params.l2 ?? 0.001;
  const { X, y } = data;
  const n = X.length;
  if (n === 0 || !X[0]?.length) throw new Error('Empty training data');
  const d = X[0].length;

  let weights = new Array(d).fill(0) as number[];
  let bias = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    let gradW = new Array(d).fill(0) as number[];
    let gradB = 0;

    for (let i = 0; i < n; i++) {
      const logit = dot(weights, X[i]) + bias;
      const pred = sigmoid(logit);
      const err = pred - y[i];

      for (let j = 0; j < d; j++) {
        gradW[j] += err * X[i][j];
      }
      gradB += err;
    }

    for (let j = 0; j < d; j++) {
      weights[j] -= lr * (gradW[j] / n + l2 * weights[j]);
    }
    bias -= lr * (gradB / n);
  }

  const model: TrainedModel = { type: 'logistic_regression', weights, bias, version: ML_TRAINERS_VERSION };
  return { model, metrics: evaluateBinary(model, data) };
}

// ── Ridge Regression (L2-regularized linear) ──────────────────────────

/**
 * Train a ridge regression model (L2-regularized OLS).
 *
 * Used as a step before XGBoost per the roadmap constraint:
 * "Train logistic/ridge/calibrated boosting before XGBoost."
 *
 * Deterministic: same inputs + same hyperparameters → same weights, always.
 */
export function trainRidgeRegression(
  data: TrainingData,
  params: { l2?: number } = {},
): TrainResult {
  const l2 = params.l2 ?? 0.1;
  const { X, y } = data;
  const n = X.length;
  if (n === 0 || !X[0]?.length) throw new Error('Empty training data');
  const d = X[0].length;

  // Closed-form: w = (X'X + λI)^{-1} X'y
  const XtX = Array.from({ length: d }, () => new Array(d).fill(0) as number[]);
  const Xty = new Array(d).fill(0) as number[];

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < d; j++) {
      Xty[j] += X[i][j] * y[i];
      for (let k = 0; k < d; k++) {
        XtX[j][k] += X[i][j] * X[i][k];
      }
    }
  }

  // Add regularization
  for (let j = 0; j < d; j++) XtX[j][j] += l2;

  // Solve via Gaussian elimination
  const weights = solveLinearSystem(XtX, Xty);

  // Compute bias as mean(y) - mean(Xw)
  let bias = 0;
  for (let i = 0; i < n; i++) {
    let pred = dot(weights, X[i]);
    bias += y[i] - pred;
  }
  bias /= n;

  const model: TrainedModel = { type: 'ridge_regression', weights, bias, version: ML_TRAINERS_VERSION };
  return { model, metrics: evaluateBinary(model, data) };
}

// ── Calibrated Boosting (gradient boosting with Platt scaling) ────────

/**
 * Train a calibrated gradient boosting model (simplified AdaBoost-style).
 *
 * Uses stumps as weak learners and Platt scaling for probability calibration.
 * This satisfies the "calibrated boosting" requirement before XGBoost.
 *
 * Deterministic: same inputs + same hyperparameters → same model, always.
 */
export function trainCalibratedBoosting(
  data: TrainingData,
  params: { nEstimators?: number; learningRate?: number; maxDepth?: number } = {},
): TrainResult {
  const nEst = params.nEstimators ?? 10;
  const lr = params.learningRate ?? 0.1;
  const { X, y } = data;
  const n = X.length;
  if (n === 0 || !X[0]?.length) throw new Error('Empty training data');
  const d = X[0].length;

  // Boosting with decision stumps
  const stumps: Stump[] = [];
  let predictions = new Array(n).fill(0.5) as number[];

  for (let t = 0; t < nEst; t++) {
    // Fit stump to pseudo-residuals
    const residuals = y.map((yi, i) => yi - predictions[i]);
    const stump = fitBestStump(X, residuals, d);
    stumps.push(stump);

    for (let i = 0; i < n; i++) {
      predictions[i] += lr * predictStump(stump, X[i]);
    }
  }

  // Platt scaling: fit sigmoid to raw predictions
  const rawScores = X.map((xi) => {
    let score = 0;
    for (let t = 0; t < stumps.length; t++) {
      score += lr * predictStump(stumps[t], xi);
    }
    return score;
  });

  const { a, b } = plattScale(rawScores, y);

  // Convert stumps to a flat weight vector (simplified for storage)
  const weights = new Array(d).fill(0) as number[];
  const bias = 0;
  // For storage, we use the Platt parameters
  weights.push(a, b);

  const model: TrainedModel = {
    type: 'calibrated_boosting',
    weights: [...stumps.map(s => s.featureIdx), a, b],
    bias: stumps.length,
    version: ML_TRAINERS_VERSION,
  };

  // Compute metrics using Platt-calibrated predictions
  const calibratedData: TrainingData = {
    X: X.map((xi, i) => [rawScores[i]]),
    y,
  };
  const calModel: TrainedModel = { type: 'platt', weights: [a], bias: b, version: ML_TRAINERS_VERSION };

  return { model, metrics: evaluateBinary(calModel, calibratedData) };
}

// ── XGBoost / LightGBM stubs ──────────────────────────────────────────

/**
 * XGBoost training stub (research-mode, no external deps).
 *
 * In production, this would use the xgboost library. For research mode,
 * we use the calibrated boosting implementation as a stand-in.
 * The interface matches what an XGBoost wrapper would expose.
 *
 * doneWhen (165): "result stored with experiment ID."
 */
export function trainXGBoost(
  data: TrainingData,
  params: { nEstimators?: number; learningRate?: number; maxDepth?: number } = {},
): TrainResult {
  // Research-mode: use calibrated boosting as XGBoost stand-in
  const result = trainCalibratedBoosting(data, { ...params, nEstimators: params.nEstimators ?? 20 });
  return {
    model: { ...result.model, type: 'xgboost_research' },
    metrics: result.metrics,
  };
}

/**
 * LightGBM training stub (research-mode, no external deps).
 *
 * In production, this would use the lightgbm library. For research mode,
 * we use the calibrated boosting implementation as a stand-in.
 */
export function trainLightGBM(
  data: TrainingData,
  params: { nEstimators?: number; learningRate?: number; maxDepth?: number } = {},
): TrainResult {
  const result = trainCalibratedBoosting(data, { ...params, nEstimators: params.nEstimators ?? 20 });
  return {
    model: { ...result.model, type: 'lightgbm_research' },
    metrics: result.metrics,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
}

function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * (b[i] ?? 0);
  return s;
}

interface Stump {
  readonly featureIdx: number;
  readonly threshold: number;
  readonly leftValue: number;
  readonly rightValue: number;
}

function fitBestStump(X: readonly (readonly number[])[], residuals: readonly number[], d: number): Stump {
  let bestLoss = Infinity;
  let best: Stump = { featureIdx: 0, threshold: 0, leftValue: 0, rightValue: 0 };

  for (let j = 0; j < d; j++) {
    const values = X.map(xi => xi[j]).sort((a, b) => a - b);
    // Try a few thresholds
    const step = Math.max(1, Math.floor(values.length / 10));
    for (let i = 0; i < values.length - 1; i += step) {
      const threshold = (values[i] + values[i + 1]) / 2;
      let leftSum = 0, leftCount = 0, rightSum = 0, rightCount = 0;
      for (let k = 0; k < X.length; k++) {
        if (X[k][j] <= threshold) { leftSum += residuals[k]; leftCount++; }
        else { rightSum += residuals[k]; rightCount++; }
      }
      const leftVal = leftCount > 0 ? leftSum / leftCount : 0;
      const rightVal = rightCount > 0 ? rightSum / rightCount : 0;
      let loss = 0;
      for (let k = 0; k < X.length; k++) {
        const pred = X[k][j] <= threshold ? leftVal : rightVal;
        loss += (residuals[k] - pred) ** 2;
      }
      if (loss < bestLoss) {
        bestLoss = loss;
        best = { featureIdx: j, threshold, leftValue: leftVal, rightValue: rightVal };
      }
    }
  }
  return best;
}

function predictStump(stump: Stump, x: readonly number[]): number {
  return (x[stump.featureIdx] ?? 0) <= stump.threshold ? stump.leftValue : stump.rightValue;
}

function plattScale(scores: readonly number[], labels: readonly number[]): { a: number; b: number } {
  // Simple Platt scaling via gradient descent on sigmoid(scores * a + b)
  let a = 1, b = 0;
  const lr = 0.01;
  for (let epoch = 0; epoch < 100; epoch++) {
    let gradA = 0, gradB = 0;
    for (let i = 0; i < scores.length; i++) {
      const p = sigmoid(a * scores[i] + b);
      const err = p - labels[i];
      gradA += err * scores[i];
      gradB += err;
    }
    a -= lr * gradA / scores.length;
    b -= lr * gradB / scores.length;
  }
  return { a, b };
}

function evaluateBinary(model: TrainedModel, data: TrainingData): ModelMetrics {
  const { X, y } = data;
  const n = X.length;
  let tp = 0, fp = 0, tn = 0, fn = 0;
  let totalLoss = 0;
  const probs: number[] = [];

  for (let i = 0; i < n; i++) {
    let score: number;
    if (model.type === 'platt') {
      score = sigmoid(model.weights[0] * X[i][0] + model.bias);
    } else {
      score = sigmoid(dot(model.weights, X[i]) + model.bias);
    }
    probs.push(score);
    const pred = score >= 0.5 ? 1 : 0;
    if (pred === 1 && y[i] === 1) tp++;
    else if (pred === 1 && y[i] === 0) fp++;
    else if (pred === 0 && y[i] === 0) tn++;
    else fn++;
    totalLoss += -(y[i] * Math.log(score + 1e-10) + (1 - y[i]) * Math.log(1 - score + 1e-10));
  }

  const accuracy = n > 0 ? (tp + tn) / n : 0;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;

  // Simple AUC approximation
  const sorted = probs.map((p, i) => ({ p, label: y[i] })).sort((a, b) => b.p - a.p);
  let posCount = y.filter(yi => yi === 1).length;
  let negCount = n - posCount;
  let auc = 0;
  let posSeen = 0, negSeen = 0;
  for (const item of sorted) {
    if (item.label === 1) { posSeen++; auc += negSeen; }
    else { negSeen++; }
  }
  auc = posCount > 0 && negCount > 0 ? auc / (posCount * negCount) : 0.5;

  return {
    accuracy,
    precision,
    recall,
    f1,
    auc,
    logLoss: n > 0 ? totalLoss / n : 0,
  };
}

function solveLinearSystem(A: readonly (readonly number[])[], b: readonly number[]): number[] {
  const n = A.length;
  // Gaussian elimination with partial pivoting
  const aug = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    // Find pivot
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

    if (Math.abs(aug[col][col]) < 1e-10) continue;

    for (let row = col + 1; row < n; row++) {
      const factor = aug[row][col] / aug[col][col];
      for (let j = col; j <= n; j++) {
        aug[row][j] -= factor * aug[col][j];
      }
    }
  }

  // Back substitution
  const x = new Array(n).fill(0) as number[];
  for (let i = n - 1; i >= 0; i--) {
    x[i] = aug[i][n];
    for (let j = i + 1; j < n; j++) {
      x[i] -= aug[i][j] * x[j];
    }
    x[i] /= aug[i][i] || 1;
  }
  return x;
}
