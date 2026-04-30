import type { BillStatus } from '../types';

interface Props {
  status: BillStatus;
  invoicesPaid?: number;
  invoicesTotal?: number;
}

export function StatusBadge({ status, invoicesPaid, invoicesTotal }: Props) {
  const allPaid =
    status === 'INVOICED' &&
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
    PAID: 'All Paid',
  };

  const displayStatus = allPaid ? 'PAID' : status;

  return (
    <span className={`px-2 py-1 rounded text-xs font-medium ${statusClasses[displayStatus]}`}>
      {statusLabels[displayStatus]}
      {status === 'INVOICED' && !allPaid && invoicesTotal !== undefined && invoicesTotal > 0 && (
        <span className="ml-1 text-gray-500">
          ({invoicesPaid || 0}/{invoicesTotal})
        </span>
      )}
    </span>
  );
}
