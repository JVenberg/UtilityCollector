import { useState, useMemo, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useBillDetail } from '../hooks/useBills';
import { useUnits } from '../hooks/useUnits';
import { calculateInvoices } from '../services/invoiceCalculator';
import { storage } from '../firebase';
import { ref, getDownloadURL } from 'firebase/storage';

export function BillDetail() {
  const { billId } = useParams<{ billId: string }>();
  const {
    bill,
    adjustments,
    readings,
    invoices,
    loading,
    error,
    saveReading,
    assignAdjustment,
    updateBillStatus,
    saveInvoice,
    markInvoicePaid,
  } = useBillDetail(billId || '');
  const { units } = useUnits();

  const [localReadings, setLocalReadings] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

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

  // Calculate preview invoices
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

    return calculateInvoices(bill, units, mergedReadings, adjustments);
  }, [bill, units, readings, adjustments, localReadings]);

  if (loading) {
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
      // Save invoices
      for (const invoice of previewInvoices) {
        await saveInvoice(invoice);
      }
      // Update bill status
      await updateBillStatus('INVOICED');
    } finally {
      setSaving(false);
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
            <StatusBadge status={bill.status} />
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
          <h2 className="text-lg font-semibold mb-4">Submeter Readings</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {units.map(unit => {
              const savedReading = readings.find(r => r.unit_id === unit.id);
              const localValue = localReadings[unit.id];
              const displayValue = localValue !== undefined
                ? localValue
                : savedReading?.reading?.toString() || '';

              return (
                <div key={unit.id} className="border rounded p-3">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {unit.name}
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      step="0.01"
                      value={displayValue}
                      onChange={(e) => setLocalReadings(prev => ({
                        ...prev,
                        [unit.id]: e.target.value
                      }))}
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                      placeholder="0.00"
                    />
                    <span className="text-gray-500 text-sm">CCF</span>
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    Submeter: {unit.submeter_id}
                  </p>
                </div>
              );
            })}
          </div>
          {Object.keys(localReadings).length > 0 && (
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
                      className={`flex items-center gap-2 px-3 py-1 rounded border cursor-pointer ${
                        adj.assigned_unit_ids?.includes(unit.id)
                          ? 'bg-blue-50 border-blue-300'
                          : 'bg-gray-50 border-gray-200'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={adj.assigned_unit_ids?.includes(unit.id) || false}
                        onChange={() => handleToggleAdjustmentUnit(adj.id, unit.id)}
                        className="rounded"
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
        <h2 className="text-lg font-semibold mb-4">
          {bill.status === 'INVOICED' ? 'Invoices' : 'Invoice Preview'}
        </h2>
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
                    />
                  )}
                </div>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {invoice.line_items.map((item, idx) => (
                    <tr key={idx} className="border-t">
                      <td className="py-1 text-gray-600">{item.description}</td>
                      <td className="py-1 text-right">${item.amount.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>

      {/* Actions */}
      {bill.status === 'PENDING_APPROVAL' && (
        <div className="flex justify-end gap-4">
          <button
            onClick={handleApproveAndSend}
            disabled={saving}
            className="px-6 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 font-medium"
          >
            {saving ? 'Processing...' : 'Approve & Send Invoices'}
          </button>
        </div>
      )}

      {bill.status === 'NEEDS_REVIEW' && (
        <div className="flex justify-end gap-4">
          <button
            onClick={() => updateBillStatus('PENDING_APPROVAL')}
            disabled={saving || adjustments.some(a => !a.assigned_unit_ids?.length)}
            className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 font-medium"
          >
            {saving ? 'Saving...' : 'Mark Ready for Approval'}
          </button>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const statusClasses: Record<string, string> = {
    NEW: 'bg-blue-100 text-blue-800',
    NEEDS_REVIEW: 'bg-yellow-100 text-yellow-800',
    PENDING_APPROVAL: 'bg-purple-100 text-purple-800',
    APPROVED: 'bg-green-100 text-green-800',
    INVOICED: 'bg-gray-100 text-gray-800',
  };

  return (
    <span className={`mt-2 inline-block px-2 py-1 rounded text-xs font-medium ${statusClasses[status] || 'bg-gray-100'}`}>
      {status.replace('_', ' ')}
    </span>
  );
}

function InvoiceStatusBadge({
  invoice,
  onMarkPaid
}: {
  invoice?: { status: string } | null;
  onMarkPaid: () => void;
}) {
  if (!invoice) return null;

  if (invoice.status === 'PAID') {
    return (
      <span className="text-green-600 text-sm font-medium">✓ Paid</span>
    );
  }

  return (
    <button
      onClick={onMarkPaid}
      className="text-blue-600 hover:underline text-sm"
    >
      Mark as Paid
    </button>
  );
}
