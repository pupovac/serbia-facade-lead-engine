/**
 * Print the confusion matrix and the per-label precision, recall and
 * false-positive rate of `classifyLead` over the labelled fixture set.
 *
 *   npx tsx scripts/report-classification-precision.ts [--errors]
 *
 * `--errors` also lists every misclassified record with its evidence, which is
 * how the signal table gets tuned.
 */
import { classifyLead } from '../src/lib/classify/index.js';
import {
  LABELLED_BUSINESSES,
  evaluateClassifier,
  toFixtureLabel,
  type FixtureLabel,
} from '../src/lib/classify/fixtures.js';

// The fixture's vocabulary: `UNKNOWN` covers both `UNCLASSIFIED` and
// `OUT_OF_SCOPE`, which the split below reports separately.
const LABELS: FixtureLabel[] = [
  'FACADE_CONTRACTOR',
  'CONSTRUCTION_MATERIAL_STORE',
  'BOTH',
  'UNKNOWN',
];

const report = evaluateClassifier();

console.log(`Labelled records: ${LABELLED_BUSINESSES.length}`);
console.log(`Overall accuracy: ${(report.accuracy * 100).toFixed(1)}%\n`);

console.log('Confusion matrix (rows = expected, columns = predicted)');
const pad = (s: string, n: number): string => s.padEnd(n);
console.log(pad('', 30) + LABELS.map((l) => pad(l.slice(0, 12), 14)).join(''));
for (const expected of LABELS) {
  const row = LABELS.map((predicted) =>
    pad(String(report.matrix[expected]?.[predicted] ?? 0), 14),
  ).join('');
  console.log(pad(expected, 30) + row);
}

console.log('\nPer label');
for (const label of LABELS) {
  const m = report.perLabel[label];
  if (m === undefined) continue;
  console.log(
    `${pad(label, 30)} predicted=${pad(String(m.predicted), 5)} correct=${pad(String(m.truePositives), 5)} ` +
      `precision=${(m.precision * 100).toFixed(1)}%  recall=${(m.recall * 100).toFixed(1)}%  ` +
      `false-positive rate=${(m.falsePositiveRate * 100).toFixed(1)}% (${m.falsePositives}/${m.negatives} negatives)`,
  );
}

if (process.argv.includes('--errors')) {
  console.log('\nMisclassified');
  for (const business of LABELLED_BUSINESSES) {
    const result = classifyLead(business.input);
    if (toFixtureLabel(result.label) === business.expected) continue;
    console.log(`\n${business.name} — expected ${business.expected}, got ${result.label}`);
    console.log(`  ${result.reason}`);
    console.log(
      `  contractor ${JSON.stringify(result.contractor)}\n  store      ${JSON.stringify(result.store)}`,
    );
    console.log(
      `  evidence: ${result.evidence.map((e) => `${e.signalId}:${e.matched}@${e.field}=${e.weight}`).join(', ')}`,
    );
  }
}
