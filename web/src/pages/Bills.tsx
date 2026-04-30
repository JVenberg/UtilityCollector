import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { useBills } from '../hooks/useBills';
import { StatusBadge } from '../components/StatusBadge';
import type { Invoice } from '../types';

export function Bills() {
  const { bills, loading, error } = useBills();
  const navigate = useNavigate();

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
      </div>

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

