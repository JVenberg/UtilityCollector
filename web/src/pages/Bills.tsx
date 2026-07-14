import { useState, useEffect, useRef, type ChangeEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { collection, getDocs } from 'firebase/firestore';
import { ref, uploadBytes } from 'firebase/storage';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db, storage } from '../firebase';
import { useBills } from '../hooks/useBills';
import { StatusBadge } from '../components/StatusBadge';
import type { Invoice } from '../types';

export function Bills() {
  const { bills, loading, error } = useBills();
  const navigate = useNavigate();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadResult, setUploadResult] = useState<
    { bill_id: string; bill_date: string; total_amount: number } | null
  >(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [needsDate, setNeedsDate] = useState(false);
  const [manualDate, setManualDate] = useState('');

  const submitUpload = async (path: string, billDate?: string) => {
    const processUploadedBill = httpsCallable<
      { pendingPath: string; billDate?: string },
      { bill_id: string; bill_date: string; total_amount: number }
    >(getFunctions(), 'processUploadedBill');
    const { data } = await processUploadedBill({ pendingPath: path, billDate });
    setUploadResult(data);
    setNeedsDate(false);
    setPendingPath(null);
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setUploading(true);
    setUploadError(null);
    setUploadResult(null);
    setNeedsDate(false);
    setManualDate('');

    try {
      const path = `bills/pending/${crypto.randomUUID()}.pdf`;
      await uploadBytes(ref(storage, path), file, { contentType: 'application/pdf' });
      setPendingPath(path);
      await submitUpload(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/bill date/i.test(message)) {
        setNeedsDate(true);
      } else {
        setUploadError(message);
      }
    } finally {
      setUploading(false);
    }
  };

  const handleRetryWithDate = async () => {
    if (!pendingPath || !manualDate) return;
    // Date input gives YYYY-MM-DD; the scraper keys bills on MM/DD/YYYY.
    const [y, m, d] = manualDate.split('-');
    setUploading(true);
    setUploadError(null);
    try {
      await submitUpload(pendingPath, `${m}/${d}/${y}`);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  // Load invoices for INVOICED bills to compute payment progress
  const [invoicesByBill, setInvoicesByBill] = useState<Record<string, Invoice[]>>({});
  const [invoicesLoading, setInvoicesLoading] = useState(false);

  useEffect(() => {
    const invoicedBills = bills.filter(b => b.status === 'INVOICED');
    if (invoicedBills.length === 0) {
      setInvoicesByBill({});
      setInvoicesLoading(false);
      return;
    }

    // Fetch all invoice collections in parallel, set state once
    let cancelled = false;
    setInvoicesLoading(true);
    Promise.all(
      invoicedBills.map(async (bill) => {
        const snapshot = await getDocs(collection(db, 'bills', bill.id, 'invoices'));
        const invs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Invoice));
        return [bill.id, invs] as const;
      })
    ).then((results) => {
      if (cancelled) return;
      const map: Record<string, Invoice[]> = {};
      for (const [billId, invs] of results) {
        map[billId] = invs;
      }
      setInvoicesByBill(map);
      setInvoicesLoading(false);
    });

    return () => { cancelled = true; };
  }, [bills]);

  if (loading || invoicesLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded">
        Error loading bills: {error}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Bills</h1>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={handleFileChange}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {uploading ? 'Uploading…' : 'Upload bill PDF'}
          </button>
        </div>
      </div>

      {uploadResult && (
        <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded flex items-center justify-between">
          <span>
            Added bill dated {uploadResult.bill_date} for ${uploadResult.total_amount.toFixed(2)}.
          </span>
          <Link
            to={`/bills/${uploadResult.bill_id}`}
            className="font-medium text-green-700 hover:text-green-900"
          >
            Review
          </Link>
        </div>
      )}

      {needsDate && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded space-y-2">
          <p className="text-sm">
            Couldn't detect the bill date from this PDF. Enter it manually:
          </p>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={manualDate}
              onChange={(e) => setManualDate(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1"
            />
            <button
              onClick={handleRetryWithDate}
              disabled={uploading || !manualDate}
              className="bg-blue-600 text-white px-3 py-1 rounded font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              Save bill
            </button>
          </div>
        </div>
      )}

      {uploadError && (
        <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded">
          {uploadError}
        </div>
      )}

      {bills.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <p className="text-gray-500 mb-4">No bills yet.</p>
          <p className="text-sm text-gray-400">
            Bills will appear here once the scraper runs.
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 sm:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Bill Date
                </th>
                <th className="hidden lg:table-cell px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Due Date
                </th>
                <th className="px-4 sm:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Amount
                </th>
                <th className="px-4 sm:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="hidden sm:table-cell px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {bills.map(bill => {
                const invoices = invoicesByBill[bill.id];
                const invoicesPaid = invoices?.filter(i => i.status === 'PAID').length;
                const invoicesTotal = invoices?.length;

                return (
                  <tr
                    key={bill.id}
                    onClick={() => navigate(`/bills/${bill.id}`)}
                    className="hover:bg-gray-50 cursor-pointer"
                  >
                    <td className="px-4 sm:px-6 py-4 whitespace-nowrap">
                      <span className="font-medium text-gray-900">{bill.bill_date}</span>
                    </td>
                    <td className="hidden lg:table-cell px-6 py-4 whitespace-nowrap text-gray-500">
                      {bill.due_date}
                    </td>
                    <td className="px-4 sm:px-6 py-4 whitespace-nowrap">
                      <span className="font-semibold">${bill.total_amount.toFixed(2)}</span>
                    </td>
                    <td className="px-4 sm:px-6 py-4 whitespace-nowrap">
                      <StatusBadge
                        status={bill.status}
                        invoicesPaid={invoicesPaid}
                        invoicesTotal={invoicesTotal}
                      />
                    </td>
                    <td className="hidden sm:table-cell px-6 py-4 whitespace-nowrap text-right">
                      <Link
                        to={`/bills/${bill.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="text-blue-600 hover:text-blue-800 font-medium"
                      >
                        {bill.status === 'INVOICED' ? 'View' : 'Review'}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

