import { Link } from 'react-router-dom';
import { useBills } from '../hooks/useBills';
import { useUnits } from '../hooks/useUnits';

export function Dashboard() {
  const { bills, loading: billsLoading } = useBills();
  const { units, loading: unitsLoading } = useUnits();

  const loading = billsLoading || unitsLoading;

  // Get counts by status
  const newBills = bills.filter(b => b.status === 'NEW').length;
  const needsReview = bills.filter(b => b.status === 'NEEDS_REVIEW').length;
  const pendingApproval = bills.filter(b => b.status === 'PENDING_APPROVAL').length;
  const recentBills = bills.slice(0, 5);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>

      {/* Stats cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard title="Total Units" value={units.length} color="blue" />
        <StatCard title="New Bills" value={newBills} color="green" />
        <StatCard title="Needs Review" value={needsReview} color="yellow" />
        <StatCard title="Pending Approval" value={pendingApproval} color="purple" />
      </div>

      {/* Quick actions */}
      {(needsReview > 0 || pendingApproval > 0) && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <h2 className="font-semibold text-yellow-800 mb-2">Action Required</h2>
          <ul className="space-y-2">
            {needsReview > 0 && (
              <li className="text-yellow-700">
                <Link to="/bills" className="underline hover:no-underline">
                  {needsReview} bill(s) need adjustment assignment
                </Link>
              </li>
            )}
            {pendingApproval > 0 && (
              <li className="text-yellow-700">
                <Link to="/bills" className="underline hover:no-underline">
                  {pendingApproval} bill(s) ready for approval
                </Link>
              </li>
            )}
          </ul>
        </div>
      )}

      {/* Recent bills */}
      <div className="bg-white rounded-lg shadow">
        <div className="px-4 py-5 border-b border-gray-200 flex justify-between items-center">
          <h2 className="text-lg font-medium text-gray-900">Recent Bills</h2>
          <Link to="/bills" className="text-blue-600 hover:text-blue-800 text-sm">
            View all →
          </Link>
        </div>
        <div className="divide-y divide-gray-200">
          {recentBills.length === 0 ? (
            <p className="px-4 py-8 text-center text-gray-500">
              No bills yet. Bills will appear here once scraped.
            </p>
          ) : (
            recentBills.map(bill => (
              <Link
                key={bill.id}
                to={`/bills/${bill.id}`}
                className="block px-4 py-4 hover:bg-gray-50"
              >
                <div className="flex justify-between items-center">
                  <div>
                    <p className="font-medium text-gray-900">{bill.bill_date}</p>
                    <p className="text-sm text-gray-500">Due: {bill.due_date}</p>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-lg font-semibold">
                      ${bill.total_amount.toFixed(2)}
                    </span>
                    <StatusBadge status={bill.status} />
                  </div>
                </div>
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({
  title,
  value,
  color
}: {
  title: string;
  value: number;
  color: 'blue' | 'green' | 'yellow' | 'purple'
}) {
  const colorClasses = {
    blue: 'bg-blue-50 text-blue-700',
    green: 'bg-green-50 text-green-700',
    yellow: 'bg-yellow-50 text-yellow-700',
    purple: 'bg-purple-50 text-purple-700',
  };

  return (
    <div className={`rounded-lg p-4 ${colorClasses[color]}`}>
      <p className="text-sm font-medium opacity-80">{title}</p>
      <p className="text-3xl font-bold mt-1">{value}</p>
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
    <span className={`px-2 py-1 rounded text-xs font-medium ${statusClasses[status] || 'bg-gray-100'}`}>
      {status.replace('_', ' ')}
    </span>
  );
}
