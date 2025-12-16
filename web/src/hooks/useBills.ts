import { useState, useEffect } from "react";
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  doc,
  updateDoc,
  setDoc,
  Timestamp,
} from "firebase/firestore";
import { db } from "../firebase";
import type { Bill, Reading, Adjustment, Invoice, BillStatus } from "../types";

export function useBills() {
  const [bills, setBills] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = query(collection(db, "bills"), orderBy("created_at", "desc"));
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const billsData = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as Bill[];

        // Sort by bill_date chronologically (bill_date is MM/DD/YYYY string)
        billsData.sort((a, b) => {
          const parseDate = (dateStr: string) => {
            const [month, day, year] = dateStr.split("/").map(Number);
            return new Date(year, month - 1, day).getTime();
          };
          return parseDate(b.bill_date) - parseDate(a.bill_date);
        });

        setBills(billsData);
        setLoading(false);
      },
      (err) => {
        setError(err.message);
        setLoading(false);
      }
    );
    return unsubscribe;
  }, []);

  return { bills, loading, error };
}

export function useBillDetail(billId: string) {
  const [bill, setBill] = useState<Bill | null>(null);
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!billId) return;

    const billRef = doc(db, "bills", billId);

    // Listen to bill document
    const unsubBill = onSnapshot(billRef, (doc) => {
      if (doc.exists()) {
        setBill({ id: doc.id, ...doc.data() } as Bill);
      }
    });

    // Listen to adjustments subcollection
    const adjRef = collection(db, "bills", billId, "adjustments");
    const unsubAdj = onSnapshot(adjRef, (snapshot) => {
      setAdjustments(
        snapshot.docs.map((d) => ({ id: d.id, ...d.data() })) as Adjustment[]
      );
    });

    // Listen to readings subcollection
    const readRef = collection(db, "bills", billId, "readings");
    const unsubRead = onSnapshot(readRef, (snapshot) => {
      setReadings(
        snapshot.docs.map((d) => ({ id: d.id, ...d.data() })) as Reading[]
      );
    });

    // Listen to invoices subcollection
    const invRef = collection(db, "bills", billId, "invoices");
    const unsubInv = onSnapshot(invRef, (snapshot) => {
      setInvoices(
        snapshot.docs.map((d) => ({ id: d.id, ...d.data() })) as Invoice[]
      );
      setLoading(false);
    });

    return () => {
      unsubBill();
      unsubAdj();
      unsubRead();
      unsubInv();
    };
  }, [billId]);

  const saveReading = async (
    unitId: string,
    submeter_id: string,
    reading: number
  ) => {
    try {
      const readingRef = doc(db, "bills", billId, "readings", unitId);
      await setDoc(
        readingRef,
        {
          unit_id: unitId,
          submeter_id,
          reading,
          created_at: Timestamp.now(),
        },
        { merge: true }
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save reading");
      throw err;
    }
  };

  const assignAdjustment = async (adjId: string, unitIds: string[]) => {
    try {
      const adjRef = doc(db, "bills", billId, "adjustments", adjId);
      await updateDoc(adjRef, { assigned_unit_ids: unitIds });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to assign adjustment"
      );
      throw err;
    }
  };

  const updateBillStatus = async (status: BillStatus) => {
    try {
      const billRef = doc(db, "bills", billId);
      const updateData: Record<string, unknown> = { status };

      if (status === "APPROVED") {
        updateData.approved_at = Timestamp.now();
      }

      await updateDoc(billRef, updateData);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to update bill status"
      );
      throw err;
    }
  };

  const saveInvoice = async (
    invoice: Omit<
      Invoice,
      "id" | "status" | "sent_at" | "paid_at" | "reminders_sent"
    >
  ) => {
    try {
      const invoiceRef = doc(db, "bills", billId, "invoices", invoice.unit_id);
      await setDoc(invoiceRef, {
        ...invoice,
        status: "DRAFT",
        sent_at: null,
        paid_at: null,
        reminders_sent: 0,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save invoice");
      throw err;
    }
  };

  const markInvoicePaid = async (unitId: string) => {
    try {
      const invoiceRef = doc(db, "bills", billId, "invoices", unitId);
      await updateDoc(invoiceRef, {
        status: "PAID",
        paid_at: Timestamp.now(),
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to mark invoice as paid"
      );
      throw err;
    }
  };

  return {
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
  };
}
