import { useState, useMemo, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { doc, onSnapshot, Timestamp } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { useBillDetail } from '../hooks/useBills';
import { useUnits } from '../hooks/useUnits';
import { useAuth } from '../hooks/useAuth';
import { useCurrentUserRole } from '../hooks/useUsers';
import {
  calculateInvoicesWithSolidWaste,
  parseSolidWasteItems,
  autoAssignSolidWaste,
  validateSolidWasteAssignments,
  validateBillTotals,
  isBillReadyForApproval,
  getSolidWasteTotal,
} from '../services/invoiceCalculator';
import { storage, db } from '../firebase';
import { ref, getDownloadURL } from 'firebase/storage';
import type { MeterReading, SolidWasteValidation } from '../types';

interface MeterReadingStatus {
  status: 'idle' | 'running' | 'completed' | 'error';
  started_at?: Timestamp;
  completed_at?: Timestamp;
  error?: string;
  result?: {
    readings_count: number;
    bill_id?: string;
    period?: { start: string; end: string };
  };
}

export function BillDetail() {
  const { billId } = useParams<{ billId: string }>();
  const {
    bill,
    adjustments,
    readings,
    invoices,
    solidWasteAssignments,
    loading,
    error,
    saveReading,
    assignAdjustment,
    updateBillStatus,
    saveInvoice,
    approveWithoutSending,
    markInvoicePaid,
    markInvoiceUnpaid,
    deleteAllInvoices,
    fetchMeterReadings,
    saveSolidWasteAssignment,
  } = useBillDetail(billId || '');
  const { units } = useUnits();
  const { user } = useAuth();
  const { isAdmin, loading: roleLoading } = useCurrentUserRole(user?.email);

  // Delete confirmation dialog state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [localReadings, setLocalReadings] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  // Meter readings state
  const [meterReadings, setMeterReadings] = useState<Record<string, MeterReading> | null>(null);
  const [fetchingReadings, setFetchingReadings] = useState(false);
  const [readingsError, setReadingsError] = useState<string | null>(null);
  const [autoFetchAttempted, setAutoFetchAttempted] = useState(false);
  const [meterReadingStatus, setMeterReadingStatus] = useState<MeterReadingStatus>({ status: 'idle' });

  // Solid waste state
  const [solidWasteAutoAssigned, setSolidWasteAutoAssigned] = useState(false);

  // Load persisted meter readings from bill document on mount
  useEffect(() => {
    if (bill?.meter_readings && Object.keys(bill.meter_readings).length > 0 && !meterReadings) {
      setMeterReadings(bill.meter_readings);
      // Update status to show readings are available
      if (meterReadingStatus.status === 'idle') {
        setMeterReadingStatus({
          status: 'completed',
          completed_at: bill.meter_readings_fetched_at || Timestamp.now(),
          result: { readings_count: Object.keys(bill.meter_readings).length, bill_id: billId },
        });
      }
    }
  }, [bill?.meter_readings, bill?.meter_readings_fetched_at, meterReadings, meterReadingStatus.status, billId]);

  // Subscribe to meter reading status updates
  useEffect(() => {
    const unsubscribe = onSnapshot(
      doc(db, 'settings', 'meter_reading_status'),
      (snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.data() as MeterReadingStatus;

          // Auto-reset if stuck in running state for more than 2 minutes
          if (data.status === 'running' && data.started_at) {
            const startedAt = data.started_at.toDate();
            const timeout = new Date(Date.now() - 2 * 60 * 1000);
            if (startedAt < timeout) {
              setMeterReadingStatus({
                status: 'error',
                started_at: data.started_at,
                completed_at: Timestamp.now(),
                error: 'Request timed out. Please try again.',
              });
              return;
            }
          }

          setMeterReadingStatus(data);
        }
      },
      (error) => {
        console.error('Error listening to meter reading status:', error);
      }
    );

    return () => unsubscribe();
  }, []);

  // Fetch meter readings from NextCentury for this bill's date range
  // @param forceOverwrite - if true, overwrite existing saved readings (manual refresh)
  //                         if false, only populate units without saved readings (auto-fetch)
  const handleFetchReadings = useCallback(async (forceOverwrite = false) => {
    if (fetchingReadings) return;

    setFetchingReadings(true);
    setReadingsError(null);
    setMeterReadingStatus({
      status: 'running',
      started_at: Timestamp.now(),
      result: { readings_count: 0, bill_id: billId }
    });

    try {
      // Always fetch fresh readings from NextCentury API for this bill's date range
      // This ensures each bill gets readings for its specific billing period
      const result = await fetchMeterReadings();

      if (result && Object.keys(result).length > 0) {
        setMeterReadings(result);

        // Pre-populate local readings with fetched meter values
        // Only populate for units that don't have:
        // 1. A locally-edited value (user override)
        // 2. A saved reading in Firestore (unless forceOverwrite is true)
        const newLocalReadings: Record<string, string> = {};
        for (const unit of units) {
          // Skip if user has already entered a local value (preserve their override)
          if (localReadings[unit.id] !== undefined) {
            continue;
          }

          // Check if unit already has a saved reading in Firestore
          const existingSavedReading = readings.find(r => r.unit_id === unit.id);
          
          // Skip units with saved readings unless this is a manual refresh
          if (existingSavedReading && !forceOverwrite) {
            continue;
          }

          // Try to match unit name to meter reading (e.g., "Unit 401" -> "401")
          const unitNumber = unit.name.replace(/[^0-9]/g, '');
          const meterReading = result[unitNumber];

          if (meterReading) {
            newLocalReadings[unit.id] = meterReading.gallons.toString();
          }
        }

        if (Object.keys(newLocalReadings).length > 0) {
          setLocalReadings(prev => ({ ...prev, ...newLocalReadings }));
        }

        // Update status to completed
        setMeterReadingStatus({
          status: 'completed',
          started_at: meterReadingStatus.started_at || Timestamp.now(),
          completed_at: Timestamp.now(),
          result: { readings_count: Object.keys(result).length, bill_id: billId },
        });
      } else {
        // No readings returned - this shouldn't happen with the new error handling
        // but keeping as a fallback
        setMeterReadingStatus({
          status: 'error',
          started_at: meterReadingStatus.started_at || Timestamp.now(),
          completed_at: Timestamp.now(),
          error: 'No readings returned. Please check NextCentury credentials in Settings.',
        });
      }
    } catch (err: unknown) {
      console.error('Error fetching readings:', err);

      // Extract meaningful error message from Firebase Functions error
      let errorMsg = 'Failed to fetch readings';
      if (err && typeof err === 'object') {
        // Firebase Functions errors have a 'message' property
        const firebaseError = err as { message?: string; code?: string; details?: string };
        if (firebaseError.message) {
          errorMsg = firebaseError.message;
        } else if (firebaseError.details) {
          errorMsg = firebaseError.details;
        }
      } else if (err instanceof Error) {
        errorMsg = err.message;
      }

      setReadingsError(errorMsg);
      setMeterReadingStatus({
        status: 'error',
        started_at: meterReadingStatus.started_at || Timestamp.now(),
        completed_at: Timestamp.now(),
        error: errorMsg,
      });
    } finally {
      setFetchingReadings(false);
    }
  }, [fetchMeterReadings, units, readings, fetchingReadings, billId, meterReadingStatus.started_at, localReadings]);

  // Auto-fetch readings when bill loads (for NEW or NEEDS_REVIEW status)
  // Pass forceOverwrite=false so we don't overwrite any saved readings
  // Only auto-fetch for admins
  // Skip if bill already has persisted meter_readings
  useEffect(() => {
    if (
      bill &&
      units.length > 0 &&
      !autoFetchAttempted &&
      !loading &&  // Wait for Firestore data to load
      !roleLoading &&  // Wait for role to load
      isAdmin &&  // Only auto-fetch for admins
      (bill.status === 'NEW' || bill.status === 'NEEDS_REVIEW')
    ) {
      setAutoFetchAttempted(true);

      // Check if bill already has persisted meter readings from previous fetch
      // If so, just update status without fetching
      if (bill.meter_readings && Object.keys(bill.meter_readings).length > 0) {
        setMeterReadingStatus({
          status: 'completed',
          completed_at: bill.meter_readings_fetched_at || Timestamp.now(),
          result: { readings_count: Object.keys(bill.meter_readings).length, bill_id: billId },
        });
        return;
      }

      // Also skip if all units already have saved readings in the subcollection
      if (readings.length >= units.length) {
        setMeterReadingStatus({
          status: 'completed',
          completed_at: Timestamp.now(),
          result: { readings_count: readings.length, bill_id: billId },
        });
        return;
      }

      // Fetch readings but don't overwrite any existing saved readings
      // forceOverwrite=false means only populate units without saved readings
      handleFetchReadings(false);
    }
  }, [bill, units, autoFetchAttempted, readings.length, loading, roleLoading, isAdmin, handleFetchReadings, billId]);

  // Convert gs:// URL to HTTPS download URL
  useEffect(() => {
    async function fetchPdfUrl() {
      if (bill?.pdf_url) {
        setPdfLoading(true);
        setPdfError(null);
        try {
          // Handle gs:// URLs
          if (bill.pdf_url.startsWith('gs://')) {
            // Extract bucket and path from gs://bucket/path
            const match = bill.pdf_url.match(/gs:\/\/([^/]+)\/(.+)/);
            if (match) {
              const [, , path] = match;
              console.log('Getting download URL for path:', path);
              const storageRef = ref(storage, path);
              const url = await getDownloadURL(storageRef);
              console.log('Got download URL:', url);
              setPdfUrl(url);
            } else {
              setPdfError('Invalid PDF URL format');
            }
          } else if (bill.pdf_url.startsWith('http')) {
            setPdfUrl(bill.pdf_url);
          } else {
            setPdfError('Unknown PDF URL format');
          }
        } catch (error) {
          console.error('Error getting PDF URL:', error);
          setPdfError(error instanceof Error ? error.message : 'Failed to load PDF');
        } finally {
          setPdfLoading(false);
        }
      }
    }
    fetchPdfUrl();
  }, [bill?.pdf_url]);

  // Parse solid waste items from bill
  const solidWasteItems = useMemo(() => {
    if (!bill) return [];
    return parseSolidWasteItems(bill);
  }, [bill]);

  // Get solid waste total from bill
  const solidWasteBillTotal = useMemo(() => {
    if (!bill) return 0;
    return getSolidWasteTotal(bill);
  }, [bill]);

  // Auto-assign solid waste when bill loads (admin only)
  useEffect(() => {
    if (
      bill &&
      units.length > 0 &&
      !solidWasteAutoAssigned &&
      !loading &&
      !roleLoading &&  // Wait for role to load
      isAdmin &&  // Only auto-assign for admins
      solidWasteAssignments.length === 0 &&
      solidWasteItems.length > 0 &&
      (bill.status === 'NEW' || bill.status === 'NEEDS_REVIEW')
    ) {
      setSolidWasteAutoAssigned(true);
      
      // Auto-assign based on unit defaults
      const autoAssignments = autoAssignSolidWaste(bill, units);
      
      // Save each assignment
      autoAssignments.forEach(async (assignment, unitId) => {
        try {
          await saveSolidWasteAssignment(assignment);
        } catch (err) {
          console.error(`Failed to auto-assign solid waste for unit ${unitId}:`, err);
        }
      });
    }
  }, [bill, units, solidWasteAutoAssigned, loading, roleLoading, isAdmin, solidWasteAssignments.length, solidWasteItems.length, saveSolidWasteAssignment]);

  // Validate solid waste assignments
  const solidWasteValidation = useMemo((): SolidWasteValidation | null => {
    if (!bill || units.length === 0) return null;
    return validateSolidWasteAssignments(bill, units, solidWasteAssignments);
  }, [bill, units, solidWasteAssignments]);

  // Calculate preview invoices with solid waste
  const previewInvoices = useMemo(() => {
    if (!bill || units.length === 0) return [];

    // Merge local readings with saved readings
    const mergedReadings = units.map(unit => {
      const savedReading = readings.find(r => r.unit_id === unit.id);
      const localValue = localReadings[unit.id];
      return {
        id: unit.id,
        unit_id: unit.id,
        submeter_id: unit.submeter_id,
        reading: localValue !== undefined
          ? parseFloat(localValue) || 0
          : savedReading?.reading || 0,
        created_at: savedReading?.created_at || null,
      };
    });

    return calculateInvoicesWithSolidWaste(bill, units, mergedReadings, adjustments, solidWasteAssignments);
  }, [bill, units, readings, adjustments, localReadings, solidWasteAssignments]);

  // Validate bill totals
  const totalsValidation = useMemo(() => {
    if (!bill || previewInvoices.length === 0) return null;
    return validateBillTotals(bill, previewInvoices);
  }, [bill, previewInvoices]);

  // Check if bill is ready for approval
  const readinessCheck = useMemo(() => {
    if (!bill || units.length === 0) return { ready: false, errors: ['Bill not loaded'] };
    
    const mergedReadings = units.map(unit => {
      const savedReading = readings.find(r => r.unit_id === unit.id);
      const localValue = localReadings[unit.id];
      return {
        id: unit.id,
        unit_id: unit.id,
        submeter_id: unit.submeter_id,
        reading: localValue !== undefined
          ? parseFloat(localValue) || 0
          : savedReading?.reading || 0,
        created_at: savedReading?.created_at || null,
      };
    });

    return isBillReadyForApproval(bill, units, mergedReadings, adjustments, solidWasteAssignments);
  }, [bill, units, readings, localReadings, adjustments, solidWasteAssignments]);

  if (loading || roleLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (error || !bill) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded">
        {error || 'Bill not found'}
      </div>
    );
  }

  const handleSaveReadings = async () => {
    setSaving(true);
    try {
      for (const unit of units) {
        const value = localReadings[unit.id];
        if (value !== undefined) {
          await saveReading(unit.id, unit.submeter_id, parseFloat(value) || 0);
        }
      }
      setLocalReadings({});
    } finally {
      setSaving(false);
    }
  };

  const handleApproveAndSend = async () => {
    setSaving(true);
    try {
      // Save invoices first
      for (const invoice of previewInvoices) {
        await saveInvoice(invoice);
      }
      
      // Call Cloud Function to send all invoice emails
      const functions = getFunctions();
      const sendAllInvoices = httpsCallable(functions, 'sendAllInvoices');
      
      const result = await sendAllInvoices({ billId });
      console.log('Emails sent:', result.data);
      
      // Note: sendAllInvoices also updates bill status to INVOICED
    } catch (err) {
      console.error('Error approving/sending invoices:', err);
      // Show error to user
      alert(err instanceof Error ? err.message : 'Failed to send invoices');
    } finally {
      setSaving(false);
    }
  };

  const handleApproveWithoutSending = async () => {
    setSaving(true);
    try {
      // Use client-side batch operation to approve bill and save invoices
      await approveWithoutSending(previewInvoices);
      console.log('Bill approved (no emails)');
    } catch (err) {
      console.error('Error approving bill:', err);
      alert(err instanceof Error ? err.message : 'Failed to approve bill');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteInvoices = async () => {
    setDeleting(true);
    try {
      await deleteAllInvoices();
      setShowDeleteConfirm(false);
    } catch (err) {
      console.error('Failed to delete invoices:', err);
    } finally {
      setDeleting(false);
    }
  };

  const handleToggleAdjustmentUnit = async (adjId: string, unitId: string) => {
    const adj = adjustments.find(a => a.id === adjId);
    if (!adj) return;

    const currentUnits = adj.assigned_unit_ids || [];
    const newUnits = currentUnits.includes(unitId)
      ? currentUnits.filter(id => id !== unitId)
      : [...currentUnits, unitId];

    await assignAdjustment(adjId, newUnits);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/bills" className="text-blue-600 hover:text-blue-800">
          ← Back to Bills
        </Link>
      </div>

      {/* Bill summary */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Bill: {bill.bill_date}</h1>
            <p className="text-gray-500 mt-1">Due: {bill.due_date}</p>
          </div>
          <div className="text-right">
            <p className="text-3xl font-bold text-gray-900">
              ${bill.total_amount.toFixed(2)}
            </p>
            <StatusBadge
              status={bill.status}
              invoicesPaid={bill.invoices_paid}
              invoicesTotal={bill.invoices_total}
            />
          </div>
        </div>
        {bill.pdf_url && (
          <div className="mt-2">
            {pdfLoading && (
              <span className="text-gray-500 text-sm">Loading PDF link...</span>
            )}
            {pdfError && (
              <span className="text-red-500 text-sm">Error: {pdfError}</span>
            )}
            {pdfUrl && (
              <a
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline text-sm"
              >
                View PDF →
              </a>
            )}
          </div>
        )}
      </div>

      {/* Meter Readings */}
      {(bill.status === 'NEW' || bill.status === 'NEEDS_REVIEW' || bill.status === 'PENDING_APPROVAL') && (
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold">Submeter Readings (Gallons)</h2>
            {isAdmin && (
              <button
                onClick={() => handleFetchReadings(true)}
                disabled={fetchingReadings || meterReadingStatus.status === 'running'}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-green-600 text-white hover:bg-green-700 rounded disabled:opacity-50 disabled:cursor-not-allowed font-medium"
              >
                {fetchingReadings || meterReadingStatus.status === 'running' ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    Fetching from Meters...
                  </>
                ) : (
                  <>
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Refresh from Meters
                  </>
                )}
              </button>
            )}
          </div>

          {/* Meter Reading Status Box */}
          <div className="mb-4 p-4 rounded-md bg-gray-50 border">
            <div className="flex items-center gap-3">
              {meterReadingStatus.status === 'running' && (
                <>
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
                  <span className="text-blue-700 font-medium">Fetching meter readings from NextCentury...</span>
                </>
              )}
              {meterReadingStatus.status === 'completed' && (
                <>
                  <svg className="h-5 w-5 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  <span className="text-green-700 font-medium">
                    Fetched {meterReadingStatus.result?.readings_count || 0} meter readings
                    {meterReadings && Object.keys(meterReadings).length > 0 && ' — Values pre-populated below'}
                  </span>
                </>
              )}
              {meterReadingStatus.status === 'error' && (
                <>
                  <svg className="h-5 w-5 text-red-600" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                  </svg>
                  <span className="text-red-700 font-medium">Error: {meterReadingStatus.error || readingsError}</span>
                </>
              )}
              {meterReadingStatus.status === 'idle' && !meterReadings && (
                <>
                  <svg className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="text-gray-600">
                    {isAdmin
                      ? 'Click "Refresh from Meters" to fetch readings from NextCentury'
                      : 'Meter readings not yet loaded for this bill'}
                  </span>
                </>
              )}
              {meterReadingStatus.status === 'idle' && meterReadings && Object.keys(meterReadings).length > 0 && (
                <>
                  <svg className="h-5 w-5 text-blue-600" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                  </svg>
                  <span className="text-blue-700 font-medium">
                    {Object.keys(meterReadings).length} readings loaded — Values pre-populated below
                  </span>
                </>
              )}
            </div>
            {meterReadingStatus.started_at && meterReadingStatus.status === 'running' && (
              <p className="text-xs text-gray-500 mt-2">
                Started: {meterReadingStatus.started_at.toDate().toLocaleTimeString()}
              </p>
            )}
            {meterReadingStatus.completed_at && meterReadingStatus.status !== 'running' && meterReadingStatus.status !== 'idle' && (
              <p className="text-xs text-gray-500 mt-2">
                Completed: {meterReadingStatus.completed_at.toDate().toLocaleTimeString()}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {units.map(unit => {
              const savedReading = readings.find(r => r.unit_id === unit.id);
              const localValue = localReadings[unit.id];
              const displayValue = localValue !== undefined
                ? localValue
                : savedReading?.reading?.toString() || '';

              // Get auto-fetched reading for this unit
              const unitNumber = unit.name.replace(/[^0-9]/g, '');
              const autoReading = meterReadings?.[unitNumber];

              return (
                <div key={unit.id} className="border rounded p-3">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {unit.name}
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      step="1"
                      value={displayValue}
                      onChange={(e) => isAdmin && setLocalReadings(prev => ({
                        ...prev,
                        [unit.id]: e.target.value
                      }))}
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                      placeholder="0"
                      disabled={!isAdmin}
                    />
                    <span className="text-gray-500 text-sm">gal</span>
                  </div>
                  <div className="flex justify-between items-center mt-1">
                    <p className="text-xs text-gray-400">
                      Submeter: {unit.submeter_id}
                    </p>
                    {autoReading && (
                      <p className="text-xs text-blue-500">
                        ({autoReading.ccf.toFixed(2)} CCF)
                      </p>
                    )}
                  </div>
                  {autoReading && isAdmin && (
                    <button
                      onClick={() => setLocalReadings(prev => ({
                        ...prev,
                        [unit.id]: autoReading.gallons.toString()
                      }))}
                      className="mt-1 text-xs text-blue-600 hover:underline"
                    >
                      Use auto-fetched: {autoReading.gallons.toLocaleString()} gal
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {isAdmin && Object.keys(localReadings).length > 0 && (
            <div className="mt-4">
              <button
                onClick={handleSaveReadings}
                disabled={saving}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Readings'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Solid Waste Assignments */}
      {solidWasteItems.length > 0 && (bill.status === 'NEW' || bill.status === 'NEEDS_REVIEW' || bill.status === 'PENDING_APPROVAL') && (
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold">Solid Waste Service</h2>
            <span className="text-sm text-gray-500">
              Bill Total: ${solidWasteBillTotal.toFixed(2)}
            </span>
          </div>

          {/* Validation Status */}
          {solidWasteValidation && (
            <div className={`mb-4 p-4 rounded-md ${
              solidWasteValidation.is_valid
                ? 'bg-green-50 border border-green-200'
                : 'bg-yellow-50 border border-yellow-200'
            }`}>
              <div className="flex items-center gap-2 mb-2">
                {solidWasteValidation.is_valid ? (
                  <>
                    <svg className="h-5 w-5 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    <span className="font-medium text-green-700">
                      Solid waste assignments valid — ${solidWasteValidation.assigned_total.toFixed(2)} assigned
                    </span>
                  </>
                ) : (
                  <>
                    <svg className="h-5 w-5 text-yellow-600" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                    <span className="font-medium text-yellow-700">
                      Assignments need attention — ${solidWasteValidation.assigned_total.toFixed(2)} / ${solidWasteValidation.bill_total.toFixed(2)}
                    </span>
                  </>
                )}
              </div>
              {solidWasteValidation.errors.length > 0 && (
                <ul className="text-sm text-yellow-700 list-disc list-inside">
                  {solidWasteValidation.errors.map((err, idx) => (
                    <li key={idx}>{err}</li>
                  ))}
                </ul>
              )}
              {solidWasteValidation.warnings.length > 0 && (
                <ul className="text-sm text-gray-600 list-disc list-inside mt-1">
                  {solidWasteValidation.warnings.map((warn, idx) => (
                    <li key={idx}>{warn}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Solid Waste Items from Bill */}
          <div className="mb-6">
            <h3 className="text-sm font-medium text-gray-700 mb-2">Bill Line Items</h3>
            <div className="bg-gray-50 rounded-lg p-3 space-y-2">
              {solidWasteItems.map((item) => (
                <div key={item.id} className="flex justify-between items-center text-sm">
                  <div className="flex items-center gap-2">
                    <span className={`inline-block w-2 h-2 rounded-full ${
                      item.service_type === 'Garbage' ? 'bg-gray-600' :
                      item.service_type === 'Food/Yard Waste' ? 'bg-green-600' :
                      'bg-blue-600'
                    }`}></span>
                    <span>
                      <span className="font-medium">{item.count}× {item.service_type}</span>
                      <span className="text-gray-500 ml-1">({item.size} gal)</span>
                    </span>
                    {item.start_date && item.end_date && (
                      <span className="text-gray-400 text-xs">
                        {item.start_date} - {item.end_date}
                      </span>
                    )}
                  </div>
                  <div className="text-right">
                    <span className="font-medium">${item.cost.toFixed(2)}</span>
                    {item.count > 1 && (
                      <span className="text-gray-400 text-xs ml-1">
                        (${item.cost_per_unit.toFixed(2)}/unit)
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Unit Assignments - Editable */}
          <div className="flex justify-between items-center mb-2">
            <h3 className="text-sm font-medium text-gray-700">Unit Assignments</h3>
            {isAdmin && (
              <button
                onClick={async () => {
                  // Re-run auto-assignment based on defaults
                  const autoAssignments = autoAssignSolidWaste(bill, units);
                  for (const [unitId, assignment] of autoAssignments) {
                    try {
                      await saveSolidWasteAssignment(assignment);
                    } catch (err) {
                      console.error(`Failed to auto-assign solid waste for unit ${unitId}:`, err);
                    }
                  }
                }}
                className="text-xs px-3 py-1 bg-gray-100 hover:bg-gray-200 rounded text-gray-600"
              >
                Reset to Defaults
              </button>
            )}
          </div>
          <p className="text-xs text-gray-500 mb-3">
            {isAdmin
              ? 'Click on an item to assign/unassign it from a unit. Each unit needs one garbage, one compost, and one recycle.'
              : 'Assignments are view-only. Contact an admin to make changes.'}
          </p>
          
          {/* Assignment Grid - Items as rows, Units as columns */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-gray-50">
                  <th className="text-left p-2 border font-medium">Item</th>
                  <th className="text-center p-2 border font-medium">Cost</th>
                  {units.map(unit => (
                    <th key={unit.id} className="text-center p-2 border font-medium min-w-[80px]">
                      {unit.name.replace('Unit ', '')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {solidWasteItems.map((item) => {
                  // Count current assignments for this item
                  const assignmentCount = solidWasteAssignments.reduce((count, swa) => {
                    const allItems = [...swa.garbage_items, ...swa.compost_items, ...swa.recycle_items];
                    return count + allItems.filter(i => i.item_id === item.id).length;
                  }, 0);
                  const remaining = item.count - assignmentCount;
                  
                  return (
                    <tr key={item.id} className="hover:bg-gray-50">
                      <td className="p-2 border">
                        <div className="flex items-center gap-2">
                          <span className={`inline-block w-2 h-2 rounded-full ${
                            item.service_type === 'Garbage' ? 'bg-gray-600' :
                            item.service_type === 'Food/Yard Waste' ? 'bg-green-600' :
                            'bg-blue-600'
                          }`}></span>
                          <span className="font-medium">{item.service_type}</span>
                          <span className="text-gray-500">{item.size} gal</span>
                          {item.count > 1 && (
                            <span className={`text-xs px-1.5 py-0.5 rounded ${
                              remaining > 0 ? 'bg-yellow-100 text-yellow-700' : 'bg-green-100 text-green-700'
                            }`}>
                              {assignmentCount}/{item.count}
                            </span>
                          )}
                        </div>
                        {item.start_date && (
                          <div className="text-xs text-gray-400 mt-0.5">
                            {item.start_date} - {item.end_date}
                          </div>
                        )}
                      </td>
                      <td className="p-2 border text-center">
                        ${item.cost_per_unit.toFixed(2)}
                      </td>
                      {units.map(unit => {
                        const assignment = solidWasteAssignments.find(a => a.unit_id === unit.id);
                        const allItems = assignment ? [
                          ...assignment.garbage_items,
                          ...assignment.compost_items,
                          ...assignment.recycle_items
                        ] : [];
                        const isAssigned = allItems.some(i => i.item_id === item.id);
                        const canAssign = remaining > 0 || isAssigned;
                        
                        // Calculate which slot this would be for fair cost assignment
                        // Count how many of this item are already assigned to OTHER units
                        const slotsUsedByOtherUnits = solidWasteAssignments
                          .filter(a => a.unit_id !== unit.id)
                          .reduce((count, swa) => {
                            const allItems = [...swa.garbage_items, ...swa.compost_items, ...swa.recycle_items];
                            return count + allItems.filter(i => i.item_id === item.id).length;
                          }, 0);
                        
                        // Get the fair cost for this slot from distributed_costs
                        const slotIndex = slotsUsedByOtherUnits;
                        const fairCost = item.distributed_costs && slotIndex < item.distributed_costs.length
                          ? item.distributed_costs[slotIndex]
                          : item.cost_per_unit;
                        
                        return (
                          <td key={unit.id} className="p-2 border text-center">
                            {isAdmin ? (
                              <button
                                onClick={async () => {
                                  if (!canAssign && !isAssigned) return;
                                  
                                  // Get current assignment or create new one
                                  const currentAssignment = solidWasteAssignments.find(a => a.unit_id === unit.id);
                                  let garbage_items = currentAssignment?.garbage_items || [];
                                  let compost_items = currentAssignment?.compost_items || [];
                                  let recycle_items = currentAssignment?.recycle_items || [];
                                  
                                  const itemAssignment = {
                                    item_id: item.id,
                                    description: item.description,
                                    size: item.size,
                                    cost: fairCost, // Use fair distribution cost based on slot
                                    start_date: item.start_date,
                                    end_date: item.end_date,
                                  };
                                  
                                  if (isAssigned) {
                                    // Remove assignment
                                    if (item.service_type === 'Garbage') {
                                      garbage_items = garbage_items.filter(i => i.item_id !== item.id);
                                    } else if (item.service_type === 'Food/Yard Waste') {
                                      compost_items = compost_items.filter(i => i.item_id !== item.id);
                                    } else {
                                      recycle_items = recycle_items.filter(i => i.item_id !== item.id);
                                    }
                                  } else {
                                    // Add assignment
                                    if (item.service_type === 'Garbage') {
                                      garbage_items = [...garbage_items, itemAssignment];
                                    } else if (item.service_type === 'Food/Yard Waste') {
                                      compost_items = [...compost_items, itemAssignment];
                                    } else {
                                      recycle_items = [...recycle_items, itemAssignment];
                                    }
                                  }
                                  
                                  // Calculate totals
                                  const garbage_total = garbage_items.reduce((sum, i) => sum + i.cost, 0);
                                  const compost_total = compost_items.reduce((sum, i) => sum + i.cost, 0);
                                  const recycle_total = recycle_items.reduce((sum, i) => sum + i.cost, 0);
                                  
                                  // Calculate the raw total first, then round only once
                                  // This avoids double-rounding errors from rounding each subtotal separately
                                  const rawTotal = garbage_total + compost_total + recycle_total;
                                  
                                  await saveSolidWasteAssignment({
                                    unit_id: unit.id,
                                    garbage_items,
                                    compost_items,
                                    recycle_items,
                                    garbage_total: Math.round(garbage_total * 100) / 100,
                                    compost_total: Math.round(compost_total * 100) / 100,
                                    recycle_total: Math.round(recycle_total * 100) / 100,
                                    total: Math.round(rawTotal * 100) / 100,
                                    auto_assigned: false,
                                  });
                                }}
                                disabled={!canAssign}
                                className={`w-8 h-8 rounded border-2 transition-colors ${
                                  isAssigned
                                    ? item.service_type === 'Garbage'
                                      ? 'bg-gray-600 border-gray-600 text-white'
                                      : item.service_type === 'Food/Yard Waste'
                                      ? 'bg-green-600 border-green-600 text-white'
                                      : 'bg-blue-600 border-blue-600 text-white'
                                    : canAssign
                                    ? 'bg-white border-gray-300 hover:border-gray-400 text-gray-400'
                                    : 'bg-gray-100 border-gray-200 text-gray-300 cursor-not-allowed'
                                }`}
                              >
                                {isAssigned ? '✓' : ''}
                              </button>
                            ) : (
                              <span className={`inline-block w-8 h-8 leading-8 rounded border-2 ${
                                isAssigned
                                  ? item.service_type === 'Garbage'
                                    ? 'bg-gray-600 border-gray-600 text-white'
                                    : item.service_type === 'Food/Yard Waste'
                                    ? 'bg-green-600 border-green-600 text-white'
                                    : 'bg-blue-600 border-blue-600 text-white'
                                  : 'bg-gray-100 border-gray-200 text-gray-300'
                              }`}>
                                {isAssigned ? '✓' : ''}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50 font-medium">
                  <td className="p-2 border">Total</td>
                  <td className="p-2 border text-center">${solidWasteBillTotal.toFixed(2)}</td>
                  {units.map(unit => {
                    const assignment = solidWasteAssignments.find(a => a.unit_id === unit.id);
                    return (
                      <td key={unit.id} className="p-2 border text-center">
                        ${(assignment?.total || 0).toFixed(2)}
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            </table>
          </div>
          
          {/* Unit Status Summary */}
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {units.map(unit => {
              const assignment = solidWasteAssignments.find(a => a.unit_id === unit.id);
              const hasGarbage = (assignment?.garbage_items.length || 0) > 0;
              const hasCompost = (assignment?.compost_items.length || 0) > 0;
              const hasRecycle = (assignment?.recycle_items.length || 0) > 0;
              const isComplete = hasGarbage && hasCompost;
              
              return (
                <div key={unit.id} className={`p-3 rounded-lg border ${isComplete ? 'bg-green-50 border-green-200' : 'bg-yellow-50 border-yellow-200'}`}>
                  <div className="flex justify-between items-center">
                    <span className="font-medium">{unit.name}</span>
                    <span className="font-semibold">${(assignment?.total || 0).toFixed(2)}</span>
                  </div>
                  <div className="flex gap-2 mt-1 text-xs">
                    <span className={hasGarbage ? 'text-green-600' : 'text-red-600'}>
                      {hasGarbage ? '✓' : '✗'} Garbage
                    </span>
                    <span className={hasCompost ? 'text-green-600' : 'text-red-600'}>
                      {hasCompost ? '✓' : '✗'} Compost
                    </span>
                    <span className={hasRecycle ? 'text-green-600' : 'text-gray-400'}>
                      {hasRecycle ? '✓' : '○'} Recycle
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Adjustments */}
      {adjustments.length > 0 && (bill.status === 'NEEDS_REVIEW' || bill.status === 'PENDING_APPROVAL') && (
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Assign Adjustments</h2>
          <p className="text-gray-500 text-sm mb-4">
            Select which units each adjustment should be split among.
          </p>
          <div className="space-y-4">
            {adjustments.map(adj => (
              <div key={adj.id} className="border rounded p-4">
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <p className="font-medium">{adj.description}</p>
                    {adj.date && <p className="text-sm text-gray-500">{adj.date}</p>}
                  </div>
                  <p className="font-semibold">${adj.cost.toFixed(2)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {units.map(unit => (
                    <label
                      key={unit.id}
                      className={`flex items-center gap-2 px-3 py-1 rounded border ${
                        isAdmin ? 'cursor-pointer' : 'cursor-default'
                      } ${
                        adj.assigned_unit_ids?.includes(unit.id)
                          ? 'bg-blue-50 border-blue-300'
                          : 'bg-gray-50 border-gray-200'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={adj.assigned_unit_ids?.includes(unit.id) || false}
                        onChange={() => isAdmin && handleToggleAdjustmentUnit(adj.id, unit.id)}
                        className="rounded"
                        disabled={!isAdmin}
                      />
                      <span className="text-sm">{unit.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Invoice Preview */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold">
            {bill.status === 'INVOICED' ? 'Invoices' : 'Invoice Preview'}
          </h2>
          <div className="flex items-center gap-4">
            {totalsValidation && (
              <div className={`text-sm ${totalsValidation.is_valid ? 'text-green-600' : 'text-red-600'}`}>
                {totalsValidation.is_valid ? (
                  <span>✓ Totals match: ${totalsValidation.calculated_total.toFixed(2)}</span>
                ) : (
                  <span>
                    ⚠ Total mismatch: ${totalsValidation.calculated_total.toFixed(2)} / ${totalsValidation.bill_total.toFixed(2)}
                    (diff: ${totalsValidation.difference.toFixed(2)})
                  </span>
                )}
              </div>
            )}
            {bill.status === 'INVOICED' && isAdmin && (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="px-3 py-1 text-sm bg-red-100 text-red-700 hover:bg-red-200 rounded font-medium"
              >
                Delete Invoices & Edit
              </button>
            )}
          </div>
        </div>

        {/* Meter Readings Summary (for INVOICED bills) */}
        {bill.status === 'INVOICED' && readings.length > 0 && (
          <div className="mb-6 bg-blue-50 border border-blue-200 rounded-lg p-4">
            <h3 className="text-sm font-semibold text-blue-800 mb-3">Meter Readings Used</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {units.map(unit => {
                const reading = readings.find(r => r.unit_id === unit.id);
                const gallons = reading?.reading || 0;
                const ccf = gallons / 748;
                return (
                  <div key={unit.id} className="bg-white rounded p-2 border border-blue-100">
                    <p className="text-sm font-medium text-gray-800">{unit.name}</p>
                    <p className="text-lg font-semibold text-blue-600">{gallons.toLocaleString()} gal</p>
                    <p className="text-xs text-gray-500">{ccf.toFixed(2)} CCF</p>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="space-y-4">
          {previewInvoices.map(invoice => (
            <div key={invoice.unit_id} className="border rounded p-4">
              <div className="flex justify-between items-center mb-3">
                <div>
                  <p className="font-medium">{invoice.unit_name}</p>
                  <p className="text-sm text-gray-500">{invoice.tenant_email}</p>
                </div>
                <div className="text-right">
                  <p className="text-xl font-bold">${invoice.amount.toFixed(2)}</p>
                  {bill.status === 'INVOICED' && (
                    <InvoiceStatusBadge
                      invoice={invoices.find(i => i.unit_id === invoice.unit_id)}
                      onMarkPaid={() => markInvoicePaid(invoice.unit_id)}
                      onMarkUnpaid={() => markInvoiceUnpaid(invoice.unit_id)}
                      isAdmin={isAdmin}
                      userEmail={user?.email || ''}
                      tenantEmail={invoice.tenant_email}
                    />
                  )}
                </div>
              </div>
              <div className="text-sm space-y-3">
                {/* Group line items by category */}
                {(() => {
                  // Define category order and labels (Water → Sewer → Solid Waste)
                  const categoryOrder = [
                    { key: 'water_usage', label: 'Water (by usage)' },
                    { key: 'water_sqft', label: 'Water (by sqft)' },
                    { key: 'sewer', label: 'Sewer' },
                    { key: 'drainage', label: 'Drainage' },
                    { key: 'solid_waste', label: 'Solid Waste' },
                    { key: 'adjustment', label: 'Adjustments' },
                  ];
                  
                  // Group items
                  const grouped = new Map<string, typeof invoice.line_items>();
                  for (const item of invoice.line_items) {
                    const cat = item.category || 'other';
                    if (!grouped.has(cat)) grouped.set(cat, []);
                    grouped.get(cat)!.push(item);
                  }
                  
                  return categoryOrder.map(({ key, label }) => {
                    const items = grouped.get(key);
                    if (!items || items.length === 0) return null;
                    
                    const categoryTotal = items.reduce((sum, i) => sum + i.amount, 0);
                    
                    return (
                      <div key={key} className="border-t pt-2">
                        <div className="flex justify-between items-center mb-1">
                          <span className="font-medium text-gray-800">{label}</span>
                          <span className="font-medium">${categoryTotal.toFixed(2)}</span>
                        </div>
                        <div className="pl-3 space-y-0.5">
                          {items.map((item, idx) => (
                            <div key={idx} className="flex justify-between text-gray-600">
                              <span>{item.description.replace(/^(Water|Sewer|Drainage): /, '')}</span>
                              <span>${item.amount.toFixed(2)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Readiness Check Summary */}
      {(bill.status === 'NEW' || bill.status === 'NEEDS_REVIEW' || bill.status === 'PENDING_APPROVAL') && (
        <div className={`bg-white rounded-lg shadow p-6 ${readinessCheck.ready ? 'border-2 border-green-200' : 'border-2 border-yellow-200'}`}>
          <div className="flex items-center gap-3 mb-3">
            {readinessCheck.ready ? (
              <>
                <svg className="h-6 w-6 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                <span className="text-lg font-semibold text-green-700">Ready for Approval</span>
              </>
            ) : (
              <>
                <svg className="h-6 w-6 text-yellow-600" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                <span className="text-lg font-semibold text-yellow-700">Not Ready - Issues Found</span>
              </>
            )}
          </div>
          {!readinessCheck.ready && readinessCheck.errors.length > 0 && (
            <ul className="text-sm text-gray-700 list-disc list-inside space-y-1">
              {readinessCheck.errors.map((err, idx) => (
                <li key={idx} className="text-red-600">{err}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Actions - Admin only */}
      {isAdmin && bill.status === 'PENDING_APPROVAL' && (
        <div className="flex justify-end gap-4">
          <button
            onClick={handleApproveWithoutSending}
            disabled={saving || !readinessCheck.ready}
            className="px-6 py-2 bg-gray-600 text-white rounded hover:bg-gray-700 disabled:opacity-50 font-medium"
          >
            {saving ? 'Processing...' : 'Approve Only (No Email)'}
          </button>
          <button
            onClick={handleApproveAndSend}
            disabled={saving || !readinessCheck.ready}
            className="px-6 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 font-medium"
          >
            {saving ? 'Processing...' : 'Approve & Send Invoices'}
          </button>
        </div>
      )}

      {isAdmin && bill.status === 'NEEDS_REVIEW' && (
        <div className="flex justify-end gap-4">
          <button
            onClick={() => updateBillStatus('PENDING_APPROVAL')}
            disabled={saving || !readinessCheck.ready}
            className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 font-medium"
            title={!readinessCheck.ready ? 'Resolve all issues before marking ready' : ''}
          >
            {saving ? 'Saving...' : 'Mark Ready for Approval'}
          </button>
        </div>
      )}

      {isAdmin && bill.status === 'NEW' && (
        <div className="flex justify-end gap-4">
          <button
            onClick={() => updateBillStatus('PENDING_APPROVAL')}
            disabled={saving || !readinessCheck.ready}
            className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 font-medium"
            title={!readinessCheck.ready ? 'Resolve all issues before marking ready' : ''}
          >
            {saving ? 'Saving...' : 'Mark Ready for Approval'}
          </button>
        </div>
      )}

      {/* View-only notice for non-admins */}
      {!isAdmin && (bill.status === 'NEW' || bill.status === 'NEEDS_REVIEW' || bill.status === 'PENDING_APPROVAL') && (
        <div className="bg-gray-100 border border-gray-200 rounded-lg p-4 text-center text-gray-600">
          <p className="font-medium">View Only</p>
          <p className="text-sm">Only administrators can modify bills and send invoices.</p>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Delete Invoices?</h3>
            <p className="text-gray-600 mb-4">
              This will delete all invoices for this bill and return it to edit mode.
              You'll need to re-approve and send invoices again.
            </p>
            <p className="text-sm text-yellow-600 bg-yellow-50 border border-yellow-200 rounded p-3 mb-4">
              ⚠️ If invoices have already been sent to tenants, they will NOT receive notification of this change.
              You may need to contact them directly.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
                className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded font-medium"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteInvoices}
                disabled={deleting}
                className="px-4 py-2 bg-red-600 text-white hover:bg-red-700 rounded font-medium disabled:opacity-50"
              >
                {deleting ? 'Deleting...' : 'Delete Invoices'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({
  status,
  invoicesPaid,
  invoicesTotal,
}: {
  status: string;
  invoicesPaid?: number;
  invoicesTotal?: number;
}) {
  // Check if all invoices are paid for INVOICED bills
  const allPaid = status === 'INVOICED' &&
    invoicesTotal !== undefined &&
    invoicesTotal > 0 &&
    invoicesPaid !== undefined &&
    invoicesPaid >= invoicesTotal;

  const statusClasses: Record<string, string> = {
    NEW: 'bg-blue-100 text-blue-800',
    NEEDS_REVIEW: 'bg-yellow-100 text-yellow-800',
    PENDING_APPROVAL: 'bg-purple-100 text-purple-800',
    APPROVED: 'bg-green-100 text-green-800',
    INVOICED: 'bg-gray-100 text-gray-800',
    PAID: 'bg-green-100 text-green-800',
  };

  const statusLabels: Record<string, string> = {
    NEW: 'New',
    NEEDS_REVIEW: 'Needs Review',
    PENDING_APPROVAL: 'Pending Approval',
    APPROVED: 'Approved',
    INVOICED: 'Invoiced',
    PAID: 'All Paid ✓',
  };

  // Show PAID badge if all invoices are paid, otherwise show original status
  const displayStatus = allPaid ? 'PAID' : status;

  return (
    <span className={`mt-2 inline-block px-2 py-1 rounded text-xs font-medium ${statusClasses[displayStatus] || 'bg-gray-100'}`}>
      {statusLabels[displayStatus] || displayStatus.replace('_', ' ')}
      {/* Show payment progress for INVOICED bills that aren't fully paid */}
      {status === 'INVOICED' && !allPaid && invoicesTotal !== undefined && invoicesTotal > 0 && (
        <span className="ml-1 text-gray-500">
          ({invoicesPaid || 0}/{invoicesTotal} paid)
        </span>
      )}
    </span>
  );
}

import type { Invoice } from '../types';

function InvoiceStatusBadge({
  invoice,
  onMarkPaid,
  onMarkUnpaid,
  isAdmin,
  userEmail,
  tenantEmail
}: {
  invoice?: Invoice | null;
  onMarkPaid: () => void;
  onMarkUnpaid: () => void;
  isAdmin: boolean;
  userEmail: string;
  tenantEmail: string;
}) {
  if (!invoice) return null;

  // Allow marking as paid if admin OR if user email matches tenant email
  const canMarkPaid = isAdmin || (userEmail && tenantEmail && userEmail.toLowerCase() === tenantEmail.toLowerCase());

  if (invoice.status === 'PAID') {
    return (
      <div className="flex items-center gap-2">
        <span className="text-green-600 text-sm font-medium">✓ Paid</span>
        {canMarkPaid && (
          <button
            onClick={onMarkUnpaid}
            className="text-gray-400 hover:text-red-600 text-xs"
            title="Mark as unpaid"
          >
            (undo)
          </button>
        )}
      </div>
    );
  }

  // INVOICED: Invoice created (check email_log for email status)
  // DRAFT: Legacy/temporary state
  if (invoice.status === 'INVOICED' || invoice.status === 'DRAFT') {
    // Check if any emails have been sent by looking at email_log or first_sent_at
    const hasEmailSent = invoice.first_sent_at || (invoice.email_log && invoice.email_log.length > 0);
    const reminderCount = invoice.email_log?.filter((e) => e.type === 'reminder').length || invoice.reminders_sent || 0;
    
    const statusLabel = invoice.status === 'DRAFT' ? 'Draft' :
                        hasEmailSent ? `Emailed${reminderCount > 0 ? ` (+${reminderCount} reminders)` : ''}` :
                        'Pending';
    
    return canMarkPaid ? (
      <div className="flex flex-col items-end gap-1">
        <button
          onClick={onMarkPaid}
          className="text-blue-600 hover:underline text-sm"
        >
          Mark as Paid
        </button>
        <span className={`text-xs ${hasEmailSent ? 'text-green-500' : 'text-gray-400'}`}>
          {statusLabel}
        </span>
      </div>
    ) : (
      <span className={`text-sm font-medium ${hasEmailSent ? 'text-green-600' : 'text-yellow-600'}`}>
        {statusLabel}
      </span>
    );
  }

  return <span className="text-gray-500 text-sm">{invoice.status}</span>;
}
