import { Link } from 'react-router-dom';
import { useBills } from '../hooks/useBills';

export function Bills() {
  const { bills, loading, error } = useBills();

  if (loading) {
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
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Bill Date
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Due Date
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Amount
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {bills.map(bill => (
                <tr key={bill.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className="font-medium text-gray-900">{bill.bill_date}</span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-gray-500">
                    {bill.due_date}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className="font-semibold">${bill.total_amount.toFixed(2)}</span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <StatusBadge status={bill.status} />
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right">
                    <Link
                      to={`/bills/${bill.id}`}
                      className="text-blue-600 hover:text-blue-800 font-medium"
                    >
                      {bill.status === 'INVOICED' ? 'View' : 'Review'}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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

  const statusLabels: Record<string, string> = {
    NEW: 'New',
    NEEDS_REVIEW: 'Needs Review',
    PENDING_APPROVAL: 'Pending Approval',
    APPROVED: 'Approved',
    INVOICED: 'Invoiced',
  };

  return (
    <span className={`px-2 py-1 rounded text-xs font-medium ${statusClasses[status] || 'bg-gray-100'}`}>
      {statusLabels[status] || status}
    </span>
  );
}
