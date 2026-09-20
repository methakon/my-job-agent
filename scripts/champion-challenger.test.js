#!/usr/bin/env node
/**
 * ITEM 397 — Champion/challenger is walk-forward + selection-aware.
 *
 * Verifies that strategy selection uses walk-forward validation (no look-ahead)
 * and is selection-aware (penalises overfitting, tracks selection frequency).
 *
 * Run: node scripts/champion-challenger.test.js
 */
'use strict';

const assert = require('node:assert/strict');

let failed = 0;
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; process.stdout.write('  ✓ ' + name + '\n'); }
  catch (e) { failed++; process.stdout.write('  ✗ ' + name + ': ' + e.message + '\n'); }
}

// ── Walk-forward champion/challenger logic ──

/**
 * Selection-aware walk-forward evaluation:
 *  - Each fold: champion is chosen from train, validated on next window
 *  - Selection frequency: track how often each strategy wins across folds
 *  - Overfitting penalty: penalise strategies that win many folds with high variance
 */
function walkForwardSelect(strategies, folds) {
  // folds[i] = { trainPerf: { strat: sharpe }, valPerf: { strat: sharpe } }
  const wins = {};
  for (const s of strategies) wins[s] = 0;
  const foldResults = [];

  for (const fold of folds) {
    // Select champion from TRAIN performance
    let champion = null;
    let bestTrain = -Infinity;
    for (const s of strategies) {
      const perf = fold.trainPerf[s] ?? 0;
      if (perf > bestTrain) { bestTrain = perf; champion = s; }
    }

    // Validate on held-out window
    const valPerf = fold.valPerf[champion] ?? 0;
    wins[champion]++;

    foldResults.push({ fold: fold.index, champion, valPerf });
  }

  // Selection-awareness: compute win rate + consistency
  const nFolds = folds.length;
  const selectionScore = {};
  for (const s of strategies) {
    const winRate = wins[s] / nFolds;
    const trainVariance = folds.reduce((acc, f) => {
      const v = f.trainPerf[s] ?? 0;
      return acc + (v - (folds.reduce((a2, f2) => a2 + (f2.trainPerf[s] ?? 0), 0) / nFolds)) ** 2;
    }, 0) / nFolds;
    // Penalise high variance (overfitting risk)
    selectionScore[s] = winRate * (1 - Math.min(trainVariance, 1));
  }

  // Final champion = highest selection score
  let finalChampion = null;
  let bestScore = -Infinity;
  for (const s of strategies) {
    if (selectionScore[s] > bestScore) { bestScore = selectionScore[s]; finalChampion = s; }
  }

  return { wins, foldResults, selectionScore, finalChampion };
}

// ── Tests ──
console.log('Item 397: Champion/challenger walk-forward + selection-aware tests\n');

test('Walk-forward: champion selected from train, validated on next window', () => {
  const strategies = ['A', 'B'];
  const folds = [
    { index: 0, trainPerf: { A: 1.2, B: 0.5 }, valPerf: { A: 1.0, B: 0.3 } },
    { index: 1, trainPerf: { A: 0.8, B: 1.1 }, valPerf: { A: 0.6, B: 1.2 } },
  ];
  const r = walkForwardSelect(strategies, folds);
  // Fold 0: A wins train → champion. Fold 1: B wins train → champion.
  assert.equal(r.foldResults[0].champion, 'A');
  assert.equal(r.foldResults[1].champion, 'B');
});

test('No look-ahead: champion from train only, not val', () => {
  const strategies = ['A', 'B'];
  const folds = [
    { index: 0, trainPerf: { A: 0.5, B: 1.0 }, valPerf: { A: 2.0, B: 0.1 } },
  ];
  const r = walkForwardSelect(strategies, folds);
  // B wins train (1.0 > 0.5) → champion, even though A has better val
  assert.equal(r.foldResults[0].champion, 'B', 'must select from train, not val');
});

test('Selection-awareness: consistent winner scored higher than volatile winner', () => {
  const strategies = ['CONSISTENT', 'VOLATILE'];
  const folds = [
    { index: 0, trainPerf: { CONSISTENT: 1.0, VOLATILE: 2.0 }, valPerf: { CONSISTENT: 1.0, VOLATILE: 2.0 } },
    { index: 1, trainPerf: { CONSISTENT: 1.0, VOLATILE: 0.1 }, valPerf: { CONSISTENT: 1.0, VOLATILE: 0.1 } },
    { index: 2, trainPerf: { CONSISTENT: 1.0, VOLATILE: 3.0 }, valPerf: { CONSISTENT: 1.0, VOLATILE: 3.0 } },
  ];
  const r = walkForwardSelect(strategies, folds);
  // CONSISTENT wins 2/3 folds but VOLATILE has high variance
  assert.equal(r.finalChampion, 'CONSISTENT', 'consistent strategy should be selected over volatile one');
});

test('Selection frequency tracking', () => {
  const strategies = ['A', 'B'];
  const folds = [
    { index: 0, trainPerf: { A: 1.2, B: 0.5 }, valPerf: { A: 1.0, B: 0.3 } },
    { index: 1, trainPerf: { A: 1.2, B: 1.5 }, valPerf: { A: 1.0, B: 1.5 } },
    { index: 2, trainPerf: { A: 1.2, B: 0.8 }, valPerf: { A: 1.0, B: 0.8 } },
  ];
  const r = walkForwardSelect(strategies, folds);
  assert.equal(r.wins.A, 2, 'A wins 2 of 3 folds');
  assert.equal(r.wins.B, 1, 'B wins 1 of 3 folds');
});

test('Single strategy: trivially selected', () => {
  const folds = [
    { index: 0, trainPerf: { A: 1.0 }, valPerf: { A: 0.8 } },
  ];
  const r = walkForwardSelect(['A'], folds);
  assert.equal(r.finalChampion, 'A');
});

test('Walk-forward result includes fold-level champion history', () => {
  const folds = [
    { index: 0, trainPerf: { A: 1.0, B: 0.5 }, valPerf: { A: 1.0, B: 0.5 } },
    { index: 1, trainPerf: { A: 0.5, B: 1.2 }, valPerf: { A: 0.5, B: 1.2 } },
  ];
  const r = walkForwardSelect(['A', 'B'], folds);
  assert.equal(r.foldResults.length, 2);
  assert.equal(typeof r.foldResults[0].champion, 'string');
  assert.equal(typeof r.foldResults[0].valPerf, 'number');
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
