/**
 * cleanup-has-adjustments.ts — remove the dead `has_adjustments` field from
 * every bill doc. Dry-run by default. Pass `--apply` to actually write.
 *
 * Touches NOTHING else: a single `FieldValue.delete()` on the named field via
 * `update()`. No subcollection access. Per-doc, sequential, idempotent.
 *
 * Run:
 *   GOOGLE_APPLICATION_CREDENTIALS=../gcreds/credentials.json \
 *     npx tsx functions/scripts/cleanup-has-adjustments.ts            # dry run
 *   GOOGLE_APPLICATION_CREDENTIALS=../gcreds/credentials.json \
 *     npx tsx functions/scripts/cleanup-has-adjustments.ts --apply    # write
 *   --limit=N    bound the run for first-time confidence
 *
 *   (or `npm run cleanup-has-adjustments [-- --apply]` from functions/)
 */

import { initializeApp, applicationDefault, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import * as fs from 'fs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const limitArg = args.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (credPath && fs.existsSync(credPath)) {
  initializeApp({ credential: cert(credPath) });
} else {
  initializeApp({ credential: applicationDefault() });
}
const db = getFirestore();

async function main() {
  const billsSnap = await db.collection('bills').get();
  console.log(`Scanning ${billsSnap.size} bills (mode=${APPLY ? 'APPLY' : 'DRY-RUN'}, limit=${LIMIT === Infinity ? 'none' : LIMIT})...\n`);

  let updated = 0;
  let failed = 0;
  let skipped = 0;
  let processed = 0;

  for (const doc of billsSnap.docs) {
    if (processed >= LIMIT) break;
    const data = doc.data();
    if (!('has_adjustments' in data)) {
      skipped++;
      continue;
    }
    processed++;
    const oldVal = data.has_adjustments;

    if (!APPLY) {
      console.log(`WOULD remove has_adjustments=${oldVal}  bills/${doc.id}`);
      continue;
    }

    try {
      await doc.ref.update({ has_adjustments: FieldValue.delete() });
      console.log(`APPLIED bills/${doc.id}  (had has_adjustments=${oldVal})`);
      updated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`ERR     bills/${doc.id}   write failed: ${msg}  (continuing)`);
      failed++;
    }
  }

  console.log('');
  if (APPLY) {
    console.log('== Apply summary ==');
    console.log(`  Updated:            ${updated}`);
    console.log(`  Failed:             ${failed}`);
    console.log(`  Skipped (no field): ${skipped}`);
    if (failed > 0) process.exit(1);
  } else {
    console.log('== Dry run summary ==');
    console.log(`  Would update ${processed} bills. Re-run with --apply to write.`);
    console.log(`  Skipped (no field): ${skipped}`);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
