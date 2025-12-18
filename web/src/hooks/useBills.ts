import { useState, useEffect, useCallback } from "react";
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
import { getFunctions, httpsCallable } from "firebase/functions";
import { db } from "../firebase";
import type {
  Bill,
  Reading,
  Adjustment,
  Invoice,
  BillStatus,
  MeterReading,
  SolidWasteAssignment,
} from "../types";

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
  const [solidWasteAssignments, setSolidWasteAssignments] = useState<SolidWasteAssignment[]>([]);
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
    });

    // Listen to solid waste assignments subcollection
    const swaRef = collection(db, "bills", billId, "solid_waste_assignments");
    const unsubSwa = onSnapshot(swaRef, (snapshot) => {
      setSolidWasteAssignments(
        snapshot.docs.map((d) => ({ id: d.id, ...d.data() })) as SolidWasteAssignment[]
      );
      setLoading(false);
    });

    return () => {
      unsubBill();
      unsubAdj();
      unsubRead();
      unsubInv();
      unsubSwa();
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

  // Save solid waste assignment for a unit
  const saveSolidWasteAssignment = async (assignment: Omit<SolidWasteAssignment, "id" | "created_at">) => {
    try {
      const swaRef = doc(db, "bills", billId, "solid_waste_assignments", assignment.unit_id);
      await setDoc(
        swaRef,
        {
          ...assignment,
          created_at: Timestamp.now(),
        },
        { merge: true }
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save solid waste assignment");
      throw err;
    }
  };

  // Delete solid waste assignment for a unit
  const deleteSolidWasteAssignment = async (unitId: string) => {
    try {
      const swaRef = doc(db, "bills", billId, "solid_waste_assignments", unitId);
      await setDoc(swaRef, { deleted: true }, { merge: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete solid waste assignment");
      throw err;
    }
  };

  // Fetch meter readings from NextCentury for the bill period
  const fetchMeterReadings = useCallback(async (): Promise<Record<
    string,
    MeterReading
  > | null> => {
    if (!bill?.parsed_data?.services) {
      throw new Error("Bill has no parsed service data");
    }

    // Find the water service - try different possible names
    const services = bill.parsed_data.services;
    const serviceNames = Object.keys(services);

    // Look for water service (case-insensitive, allows partial match)
    const waterServiceName = serviceNames.find(
      (name) =>
        name.toLowerCase().includes("water") &&
        !name.toLowerCase().includes("adjustment")
    );

    if (!waterServiceName) {
      throw new Error(
        `No water service found in bill. Available services: ${serviceNames.join(
          ", "
        )}`
      );
    }

    const waterService = services[waterServiceName];
    if (!waterService?.parts?.length) {
      throw new Error(
        `Water service "${waterServiceName}" has no parts. Available services: ${serviceNames.join(
          ", "
        )}`
      );
    }

    // Get the date range from the water service
    const firstPart = waterService.parts[0];
    const startDate = firstPart.start_date;
    const endDate = firstPart.end_date;

    if (!startDate || !endDate) {
      throw new Error(
        `No date range found in water service "${waterServiceName}". Start: ${startDate}, End: ${endDate}`
      );
    }

    console.log(`Fetching readings for period: ${startDate} to ${endDate}`);

    const functions = getFunctions();
    const fetchReadings = httpsCallable<
      { startDate: string; endDate: string },
      {
        success: boolean;
        readings: Record<string, MeterReading>;
        unit: string;
        error?: string;
      }
    >(functions, "fetchMeterReadings");

    const result = await fetchReadings({ startDate, endDate });

    if (result.data.success && result.data.readings) {
      return result.data.readings;
    }

    if (result.data.error) {
      throw new Error(result.data.error);
    }

    throw new Error("No readings returned from NextCentury");
  }, [bill]);

  return {
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
    markInvoicePaid,
    fetchMeterReadings,
    saveSolidWasteAssignment,
    deleteSolidWasteAssignment,
  };
}
