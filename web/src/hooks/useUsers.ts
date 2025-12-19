import { useState, useEffect } from "react";
import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "../firebase";
import type { AppUser, UserRole } from "../types";

export function useUsers() {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onSnapshot(
      collection(db, "users"),
      (snapshot) => {
        const usersData: AppUser[] = [];
        snapshot.forEach((doc) => {
          usersData.push({
            id: doc.id,
            ...doc.data(),
          } as AppUser);
        });
        setUsers(usersData);
        setLoading(false);
      },
      (err) => {
        console.error("Error loading users:", err);
        setError(err.message);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, []);

  async function addUser(email: string, role: UserRole, addedBy: string) {
    // Use email directly as document ID (lowercase normalized)
    const normalizedEmail = email.toLowerCase();
    const userRef = doc(db, "users", normalizedEmail);
    await setDoc(userRef, {
      email: normalizedEmail,
      role,
      added_by: addedBy,
      created_at: serverTimestamp(),
    });
  }

  async function updateUserRole(userEmail: string, role: UserRole) {
    const userRef = doc(db, "users", userEmail);
    await setDoc(userRef, { role }, { merge: true });
  }

  async function removeUser(userEmail: string) {
    await deleteDoc(doc(db, "users", userEmail));
  }

  // Bootstrap function for first admin
  async function bootstrapAdmin(email: string) {
    const normalizedEmail = email.toLowerCase();
    const userRef = doc(db, "users", normalizedEmail);
    await setDoc(userRef, {
      email: normalizedEmail,
      role: "admin" as UserRole,
      added_by: "bootstrap",
      created_at: serverTimestamp(),
    });
  }

  return {
    users,
    loading,
    error,
    addUser,
    updateUserRole,
    removeUser,
    bootstrapAdmin,
  };
}

// Hook to get current user's role
export function useCurrentUserRole(email: string | null | undefined) {
  const [role, setRole] = useState<UserRole | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasChecked, setHasChecked] = useState(false);
  const [currentEmail, setCurrentEmail] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    // Track email changes to detect when we need to reset
    if (email !== currentEmail) {
      setCurrentEmail(email);
      // Always reset to loading state when email changes
      setLoading(true);
      setRole(null);
      setHasChecked(false);
    }

    if (!email) {
      // No email provided - keep loading false only after we've confirmed no email
      // Use a small delay to allow auth state to stabilize
      const timeout = setTimeout(() => {
        setLoading(false);
        setHasChecked(true);
      }, 100);
      return () => clearTimeout(timeout);
    }

    // Use email directly as document ID (lowercase)
    const normalizedEmail = email.toLowerCase();
    const userRef = doc(db, "users", normalizedEmail);

    const unsubscribe = onSnapshot(
      userRef,
      (snapshot) => {
        if (snapshot.exists()) {
          setRole(snapshot.data().role as UserRole);
        } else {
          setRole(null);
        }
        setLoading(false);
        setHasChecked(true);
      },
      (err) => {
        console.error("Error getting user role:", err);
        setRole(null);
        setLoading(false);
        setHasChecked(true);
      }
    );

    return () => unsubscribe();
  }, [email, currentEmail]);

  // Return loading=true if email changed but effect hasn't run yet
  const effectiveLoading = loading || (email !== currentEmail);

  return { role, loading: effectiveLoading, isAdmin: role === "admin", hasChecked };
}
