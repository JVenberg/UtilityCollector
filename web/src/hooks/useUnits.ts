import { useState, useEffect } from "react";
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  Timestamp,
} from "firebase/firestore";
import { db } from "../firebase";
import type { Unit } from "../types";

export function useUnits() {
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = query(collection(db, "units"), orderBy("name"));
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const unitsData = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as Unit[];
        setUnits(unitsData);
        setLoading(false);
      },
      (err) => {
        setError(err.message);
        setLoading(false);
      }
    );
    return unsubscribe;
  }, []);

  const addUnit = async (unit: Omit<Unit, "id" | "created_at">) => {
    try {
      await addDoc(collection(db, "units"), {
        ...unit,
        created_at: Timestamp.now(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add unit");
      throw err;
    }
  };

  const updateUnit = async (
    id: string,
    data: Partial<Omit<Unit, "id" | "created_at">>
  ) => {
    try {
      await updateDoc(doc(db, "units", id), data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update unit");
      throw err;
    }
  };

  const deleteUnit = async (id: string) => {
    try {
      await deleteDoc(doc(db, "units", id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete unit");
      throw err;
    }
  };

  return {
    units,
    loading,
    error,
    addUnit,
    updateUnit,
    deleteUnit,
  };
}
