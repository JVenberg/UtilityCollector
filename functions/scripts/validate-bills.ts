/**
 * validate-bills.ts — read-only schema validator for the `bills` collection.
 *
 * Walks every bill doc and every adjustment doc under
 * `bills/<id>/adjustments/<id>` and validates each against the post-custom-
 * adjustments schema. NEVER writes anything.
 *
 * Run:
 *   GOOGLE_APPLICATION_CREDENTIALS=../gcreds/credentials.json \
 *     npx tsx functions/scripts/validate-bills.ts
 *
 *   (or `npm run validate-bills` from functions/)
 *
 * Exit code:
 *   0  no errors
 *   1  at least one error found
 */

import { initializeApp, applicationDefault, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as fs from 'fs';

// Initialize Admin SDK. Prefers GOOGLE_APPLICATION_CREDENTIALS; falls back to
// the conventional gcreds/credentials.json path used by other scripts in this
// repo.
const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (credPath && fs.existsSync(credPath)) {
  initializeApp({ credential: cert(credPath) });
} else {
  initializeApp({ credential: applicationDefault() });
}
const db = getFirestore();

const VALID_STATUSES = new Set([
  'NEW',
  'NEEDS_REVIEW',
  'PENDING_APPROVAL',
  'APPROVED',
  'INVOICED',
]);

interface BillResult {
  id: string;
  status: string;
  errors: string[];
  warnings: string[];
  hasAdjustmentsField: boolean;
  adjustmentsScanned: number;
  adjustmentErrors: number;
}

const results: BillResult[] = [];
let totalErrors = 0;
let totalWarnings = 0;
let totalAdjustments = 0;
let totalAdjustmentErrors = 0;

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

async function validateBill(billId: string, data: FirebaseFirestore.DocumentData): Promise<BillResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!VALID_STATUSES.has(data.status)) {
    errors.push(`status invalid or missing: ${JSON.stringify(data.status)}`);
  }
  if (!isFiniteNumber(data.total_amount)) {
    errors.push(`total_amount missing or not a finite number: ${JSON.stringify(data.total_amount)}`);
  }
  for (const f of ['bill_date', 'due_date', 'pdf_url']) {
    if (typeof data[f] !== 'string') {
      errors.push(`${f} missing or not a string`);
    }
  }
  if (!data.services || typeof data.services !== 'object') {
    errors.push('services missing or not an object');
  }

  const hasAdjustmentsField = 'has_adjustments' in data;
  if (hasAdjustmentsField) {
    warnings.push('has_adjustments field present (legacy; cleanup script will remove)');
  }

  // Walk adjustments subcollection
  const adjSnap = await db.collection('bills').doc(billId).collection('adjustments').get();
  let adjustmentErrors = 0;
  for (const adjDoc of adjSnap.docs) {
    const a = adjDoc.data();
    if (typeof a.description !== 'string' || !a.description.trim()) {
      errors.push(`adj ${adjDoc.id}: description missing or empty`);
      adjustmentErrors++;
    }
    if (!isFiniteNumber(a.cost)) {
      errors.push(`adj ${adjDoc.id}: cost not a finite number: ${JSON.stringify(a.cost)}`);
      adjustmentErrors++;
    }
    if (a.date !== null && typeof a.date !== 'string') {
      errors.push(`adj ${adjDoc.id}: date must be string or null, got ${JSON.stringify(a.date)}`);
      adjustmentErrors++;
    }
    if (!Array.isArray(a.assigned_unit_ids)) {
      errors.push(`adj ${adjDoc.id}: assigned_unit_ids must be array, got ${JSON.stringify(a.assigned_unit_ids)}`);
      adjustmentErrors++;
    } else {
      for (const id of a.assigned_unit_ids) {
        if (typeof id !== 'string') {
          errors.push(`adj ${adjDoc.id}: assigned_unit_ids contains non-string`);
          adjustmentErrors++;
          break;
        }
      }
    }
    // custom must be undefined/missing OR strictly true. false or other values
    // are bug indicators (no code path should ever write them).
    if ('custom' in a && a.custom !== true) {
      errors.push(`adj ${adjDoc.id}: custom must be true or absent, got ${JSON.stringify(a.custom)}`);
      adjustmentErrors++;
    }
  }
  totalAdjustments += adjSnap.size;
  totalAdjustmentErrors += adjustmentErrors;

  return {
    id: billId,
    status: data.status,
    errors,
    warnings,
    hasAdjustmentsField,
    adjustmentsScanned: adjSnap.size,
    adjustmentErrors,
  };
}

async function main() {
  const billsSnap = await db.collection('bills').get();
  console.log(`Scanning ${billsSnap.size} bills...\n`);

  for (const billDoc of billsSnap.docs) {
    const r = await validateBill(billDoc.id, billDoc.data());
    results.push(r);
    totalErrors += r.errors.length;
    totalWarnings += r.warnings.length;

    console.log(`== Bill ${r.id} (status=${r.status}) ==`);
    if (r.errors.length === 0 && r.warnings.length === 0 && r.adjustmentErrors === 0) {
      console.log(`  OK   schema valid`);
    }
    for (const w of r.warnings) console.log(`  WARN ${w}`);
    for (const e of r.errors) console.log(`  ERR  ${e}`);
    if (r.adjustmentsScanned > 0) {
      const ok = r.adjustmentErrors === 0;
      console.log(
        `  ${ok ? 'OK  ' : 'ERR '} ${r.adjustmentsScanned} adjustments${ok ? ', all schema-valid' : `, ${r.adjustmentErrors} with errors`}`
      );
    } else {
      console.log(`  OK   0 adjustments`);
    }
  }

  const billsWithHasAdjustmentsField = results.filter((r) => r.hasAdjustmentsField).length;
  const billsWithErrors = results.filter((r) => r.errors.length > 0).length;
  const billsWithWarnings = results.filter((r) => r.warnings.length > 0).length;

  console.log('');
  console.log('== Summary ==');
  console.log(`  Bills scanned:                    ${results.length}`);
  console.log(`  Bills with has_adjustments field: ${billsWithHasAdjustmentsField}`);
  console.log(`  Bills with errors:                ${billsWithErrors}`);
  console.log(`  Bills with warnings:              ${billsWithWarnings}`);
  console.log(`  Adjustments scanned:              ${totalAdjustments}`);
  console.log(`  Adjustments with errors:          ${totalAdjustmentErrors}`);
  console.log(`  Total errors:                     ${totalErrors}`);
  console.log(`  Total warnings:                   ${totalWarnings}`);

  if (totalErrors > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
