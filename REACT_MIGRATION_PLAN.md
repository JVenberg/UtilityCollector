# Firebase Migration Plan: React + Firestore Architecture

## Overview

Migrate from Docker/SQLite/FastAPI to a **Firebase-native** architecture:

- **React app** on Firebase Hosting (client-side)
- **Firestore** for all data (accessed via client SDK)
- **Cloud Run** ONLY for Playwright scraping
- **Firebase Auth** for Google authentication
- **Cloud Scheduler** to trigger scraping jobs

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Firebase Hosting                              │
│                    (React + Vite App)                           │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  - Dashboard: View bills, invoices                      │    │
│  │  - Unit Management: Add/edit units, trash cans          │    │
│  │  - Bill Review: Assign adjustments, approve invoices    │    │
│  │  - Payment Tracking: Mark invoices as paid              │    │
│  │  - Invoice Calculator: Client-side JS calculation       │    │
│  └─────────────────────────────────────────────────────────┘    │
│         │                                                        │
│         │ Firestore SDK (direct read/write)                     │
│         ▼                                                        │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                   Firestore Database                     │    │
│  │  /units, /bills, /settings, /gmail_tokens               │    │
│  └─────────────────────────────────────────────────────────┘    │
│         │                                                        │
│         │ Firebase Storage SDK                                   │
│         ▼                                                        │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                  Firebase Storage                        │    │
│  │                   /bills/*.pdf                           │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      Cloud Scheduler                             │
│                    (every 3 days @ 6am)                         │
│                            │                                     │
│                            ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              Cloud Run: Scraper Function                 │    │
│  │  - Python + Playwright                                   │    │
│  │  - Login to Seattle Utilities                            │    │
│  │  - Download new bill PDFs                                │    │
│  │  - Parse PDF content                                     │    │
│  │  - Write to Firestore                                    │    │
│  │  - Upload PDF to Storage                                 │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

## Technology Stack

| Component        | Technology                                |
| ---------------- | ----------------------------------------- |
| **Frontend**     | React + Vite + TypeScript                 |
| **Styling**      | Tailwind CSS                              |
| **Database**     | Firestore (client SDK)                    |
| **Auth**         | Firebase Auth (Google provider)           |
| **File Storage** | Firebase Storage                          |
| **Hosting**      | Firebase Hosting                          |
| **Scraping**     | Cloud Run (Python + Playwright)           |
| **Scheduling**   | Cloud Scheduler                           |
| **Email**        | Gmail API (client-side or Cloud Function) |

## Firestore Schema

```typescript
// /units/{unitId}
interface Unit {
  id: string;
  name: string; // "Unit 401"
  sqft: number;
  submeter_id: string;
  email: string;
  trash_cans: TrashCan[]; // Embedded array
  created_at: Timestamp;
}

interface TrashCan {
  service_type: string; // "Garbage", "Recycle"
  size: number; // gallons
}

// /bills/{billId}
interface Bill {
  id: string;
  bill_date: string;
  due_date: string;
  total_amount: number;
  pdf_url: string; // Firebase Storage URL
  status: "NEW" | "NEEDS_REVIEW" | "PENDING_APPROVAL" | "APPROVED" | "INVOICED";
  has_adjustments: boolean;
  parsed_data: object; // Full parsed bill data (stored for calculations)
  created_at: Timestamp;
  approved_at: Timestamp | null;
  approved_by: string | null;
}

// /bills/{billId}/readings/{unitId}
interface Reading {
  unit_id: string;
  submeter_id: string;
  reading: number;
  created_at: Timestamp;
}

// /bills/{billId}/adjustments/{adjustmentId}
interface Adjustment {
  description: string;
  cost: number;
  date: string | null;
  assigned_unit_ids: string[]; // Empty = unassigned
}

// /bills/{billId}/invoices/{unitId}
interface Invoice {
  unit_id: string;
  unit_name: string;
  tenant_email: string;
  amount: number;
  line_items: LineItem[];
  status: "DRAFT" | "SENT" | "PAID";
  sent_at: Timestamp | null;
  paid_at: Timestamp | null;
  reminders_sent: number;
}

interface LineItem {
  description: string;
  amount: number;
}

// /settings/config
interface Settings {
  require_approval: boolean;
  reminder_days: number[];
  seattle_utilities_account: string;
}

// /gmail_tokens/default
interface GmailToken {
  access_token: string;
  refresh_token: string;
  expiry: Timestamp;
  updated_at: Timestamp;
}
```

## Project Structure

```
/utility-billing/
├── firebase.json
├── firestore.rules
├── firestore.indexes.json
├── storage.rules
├── .firebaserc
│
├── web/                           # React Frontend
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── tailwind.config.js
│   ├── index.html
│   │
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── firebase.ts            # Firebase initialization
│       │
│       ├── components/
│       │   ├── Layout.tsx
│       │   ├── Navbar.tsx
│       │   ├── BillCard.tsx
│       │   ├── UnitCard.tsx
│       │   ├── InvoiceTable.tsx
│       │   └── AdjustmentForm.tsx
│       │
│       ├── pages/
│       │   ├── Login.tsx
│       │   ├── Dashboard.tsx
│       │   ├── Bills.tsx
│       │   ├── BillDetail.tsx
│       │   ├── Units.tsx
│       │   ├── UnitEdit.tsx
│       │   └── Settings.tsx
│       │
│       ├── hooks/
│       │   ├── useAuth.ts
│       │   ├── useBills.ts
│       │   ├── useUnits.ts
│       │   └── useFirestore.ts
│       │
│       ├── services/
│       │   ├── invoiceCalculator.ts  # Client-side calculation
│       │   └── emailService.ts       # Gmail API client
│       │
│       └── types/
│           └── index.ts              # TypeScript interfaces
│
├── scraper/                       # Cloud Run Scraper (Python)
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── main.py                   # Flask/FastAPI endpoint
│   ├── scraper.py                # Seattle Utilities scraper
│   ├── parser.py                 # PDF parser
│   └── cloudbuild.yaml
│
└── functions/                     # Optional: Firebase Cloud Functions
    ├── package.json
    └── src/
        └── index.ts               # Email sending, reminders
```

## Implementation Phases

### Phase 1: React App Setup (Firebase Hosting)

**Goal:** Basic React app with Firebase Auth and Firestore

```bash
# Create React app with Vite
cd utility-billing
npm create vite@latest web -- --template react-ts
cd web
npm install

# Install Firebase and dependencies
npm install firebase react-router-dom
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
```

**Key Files:**

**web/src/firebase.ts:**

```typescript
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: "utilitysplitter.firebaseapp.com",
  projectId: "utilitysplitter",
  storageBucket: "utilitysplitter.appspot.com",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);
export const storage = getStorage(app);
```

**web/src/hooks/useAuth.ts:**

```typescript
import { useState, useEffect } from "react";
import {
  User,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "firebase/auth";
import { auth, googleProvider } from "../firebase";

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const login = () => signInWithPopup(auth, googleProvider);
  const logout = () => signOut(auth);

  return { user, loading, login, logout };
}
```

**Test:** Can login with Google, see authenticated state

---

### Phase 2: Units Management (Firestore CRUD)

**Goal:** Full CRUD for units with trash cans

**web/src/hooks/useUnits.ts:**

```typescript
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
import { Unit, TrashCan } from "../types";

export function useUnits() {
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, "units"), orderBy("name"));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const unitsData = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })) as Unit[];
      setUnits(unitsData);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const addUnit = async (unit: Omit<Unit, "id" | "created_at">) => {
    await addDoc(collection(db, "units"), {
      ...unit,
      created_at: Timestamp.now(),
    });
  };

  const updateUnit = async (id: string, data: Partial<Unit>) => {
    await updateDoc(doc(db, "units", id), data);
  };

  const deleteUnit = async (id: string) => {
    await deleteDoc(doc(db, "units", id));
  };

  return { units, loading, addUnit, updateUnit, deleteUnit };
}
```

**web/src/pages/Units.tsx:**

```tsx
import { useState } from "react";
import { useUnits } from "../hooks/useUnits";
import { UnitCard } from "../components/UnitCard";

export function Units() {
  const { units, loading, addUnit, deleteUnit } = useUnits();
  const [showForm, setShowForm] = useState(false);

  if (loading) return <div>Loading...</div>;

  return (
    <div className="container mx-auto p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Units</h1>
        <button
          onClick={() => setShowForm(true)}
          className="bg-blue-500 text-white px-4 py-2 rounded"
        >
          Add Unit
        </button>
      </div>

      <div className="grid gap-4">
        {units.map((unit) => (
          <UnitCard
            key={unit.id}
            unit={unit}
            onDelete={() => deleteUnit(unit.id)}
          />
        ))}
      </div>
    </div>
  );
}
```

**Test:** Can add, edit, delete units with trash cans

---

### Phase 3: Cloud Run Scraper

**Goal:** Standalone scraper service that writes to Firestore

**scraper/requirements.txt:**

```
flask
gunicorn
firebase-admin
google-cloud-firestore
google-cloud-storage
playwright
pypdf2
```

**scraper/Dockerfile:**

```dockerfile
FROM python:3.13-slim

# Install Playwright dependencies
RUN apt-get update && apt-get install -y \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt
RUN playwright install chromium

COPY . .

CMD ["gunicorn", "-b", "0.0.0.0:8080", "main:app"]
```

**scraper/main.py:**

```python
import os
import logging
from flask import Flask, jsonify
from scraper import SeattleUtilitiesScraper
from parser import BillParser
from firebase_admin import credentials, firestore, initialize_app, storage

# Initialize Firebase
cred = credentials.ApplicationDefault()
initialize_app(cred, {'storageBucket': 'utilitysplitter.appspot.com'})
db = firestore.client()
bucket = storage.bucket()

app = Flask(__name__)
log = logging.getLogger(__name__)

@app.route('/scrape', methods=['POST'])
def scrape_bills():
    """Called by Cloud Scheduler to check for new bills."""
    try:
        # Get credentials from Secret Manager
        username = os.environ.get('UTILITY_USERNAME')
        password = os.environ.get('UTILITY_PASSWORD')
        account = os.environ.get('UTILITY_ACCOUNT')

        scraper = SeattleUtilitiesScraper(username, password, account)
        parser = BillParser()

        # Check for new bills
        bills = scraper.check_for_new_bills()
        new_bills = []

        for bill_info in bills:
            # Check if already exists in Firestore
            existing = db.collection('bills').where(
                'bill_date', '==', bill_info['date']
            ).get()

            if existing:
                continue

            # Download and parse
            pdf_path = scraper.download_bill(bill_info['date'])
            parsed_data = parser.parse(pdf_path)

            # Upload PDF to Storage
            blob_name = f"bills/{bill_info['date'].replace('/', '-')}.pdf"
            blob = bucket.blob(blob_name)
            blob.upload_from_filename(pdf_path)
            pdf_url = f"gs://utilitysplitter.appspot.com/{blob_name}"

            # Create Firestore document
            bill_ref = db.collection('bills').add({
                'bill_date': bill_info['date'],
                'due_date': parsed_data['due_date'],
                'total_amount': parsed_data['total'],
                'pdf_url': pdf_url,
                'status': 'NEW',
                'has_adjustments': parsed_data['has_adjustments'],
                'parsed_data': parsed_data,
                'created_at': firestore.SERVER_TIMESTAMP,
            })

            # Save adjustments as subcollection
            for adj in parsed_data.get('adjustments', []):
                db.collection('bills').document(bill_ref[1].id).collection('adjustments').add({
                    'description': adj['description'],
                    'cost': adj['cost'],
                    'date': adj.get('date'),
                    'assigned_unit_ids': [],
                })

            new_bills.append(bill_info['date'])

        return jsonify({
            'success': True,
            'new_bills': new_bills,
            'total_checked': len(bills)
        })

    except Exception as e:
        log.error(f"Scraping error: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'healthy'})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080)
```

**Deploy:**

```bash
cd scraper
gcloud builds submit --tag gcr.io/utilitysplitter/scraper
gcloud run deploy scraper \
    --image gcr.io/utilitysplitter/scraper \
    --platform managed \
    --region us-central1 \
    --memory 1Gi \
    --timeout 300 \
    --set-env-vars "UTILITY_USERNAME=xxx,UTILITY_PASSWORD=xxx,UTILITY_ACCOUNT=xxx"
```

**Test:** Manual trigger downloads bills to Firestore

---

### Phase 4: Bills Dashboard & Review

**Goal:** View bills, assign adjustments, approve invoices

**web/src/hooks/useBills.ts:**

```typescript
import { useState, useEffect } from "react";
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  doc,
  updateDoc,
  Timestamp,
} from "firebase/firestore";
import { db } from "../firebase";
import { Bill, Reading, Adjustment, Invoice } from "../types";

export function useBills() {
  const [bills, setBills] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, "bills"), orderBy("bill_date", "desc"));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const billsData = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })) as Bill[];
      setBills(billsData);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  return { bills, loading };
}

export function useBillDetail(billId: string) {
  const [bill, setBill] = useState<Bill | null>(null);
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
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
      setLoading(false);
    });

    return () => {
      unsubBill();
      unsubAdj();
      unsubRead();
    };
  }, [billId]);

  const saveReading = async (unitId: string, reading: number) => {
    const readingRef = doc(db, "bills", billId, "readings", unitId);
    await updateDoc(readingRef, { reading, updated_at: Timestamp.now() });
  };

  const assignAdjustment = async (adjId: string, unitIds: string[]) => {
    const adjRef = doc(db, "bills", billId, "adjustments", adjId);
    await updateDoc(adjRef, { assigned_unit_ids: unitIds });
  };

  return {
    bill,
    adjustments,
    readings,
    loading,
    saveReading,
    assignAdjustment,
  };
}
```

**Test:** Full review flow works

---

### Phase 5: Invoice Calculator (Client-Side)

**Goal:** Calculate invoices in JavaScript

**web/src/services/invoiceCalculator.ts:**

```typescript
import { Unit, Bill, Reading, Adjustment } from "../types";

interface LineItem {
  description: string;
  amount: number;
}

interface Invoice {
  unit_id: string;
  unit_name: string;
  tenant_email: string;
  amount: number;
  line_items: LineItem[];
}

export function calculateInvoices(
  bill: Bill,
  units: Unit[],
  readings: Reading[],
  adjustments: Adjustment[]
): Invoice[] {
  const parsedData = bill.parsed_data;
  const totalSqft = units.reduce((sum, u) => sum + u.sqft, 0);

  // Get water/sewer costs from parsed data
  const waterService = findService(parsedData, "Water");
  const sewerService = findService(parsedData, "Sewer");

  const totalUsage = readings.reduce((sum, r) => sum + r.reading, 0);
  const waterCostPerCcf = waterService ? waterService.total / totalUsage : 0;
  const sewerCostPerCcf = sewerService ? sewerService.total / totalUsage : 0;

  return units.map((unit) => {
    const unitReading =
      readings.find((r) => r.unit_id === unit.id)?.reading || 0;
    const sqftRatio = unit.sqft / totalSqft;

    const lineItems: LineItem[] = [
      {
        description: `Water (${unitReading.toFixed(2)} CCF)`,
        amount: round(unitReading * waterCostPerCcf),
      },
      {
        description: "Sewer",
        amount: round(unitReading * sewerCostPerCcf),
      },
    ];

    // Add adjustments for this unit
    adjustments.forEach((adj) => {
      if (adj.assigned_unit_ids.includes(unit.id)) {
        const splitCount = adj.assigned_unit_ids.length;
        lineItems.push({
          description: adj.description,
          amount: round(adj.cost / splitCount),
        });
      }
    });

    const total = lineItems.reduce((sum, li) => sum + li.amount, 0);

    return {
      unit_id: unit.id,
      unit_name: unit.name,
      tenant_email: unit.email,
      amount: total,
      line_items: lineItems,
    };
  });
}

function findService(parsedData: any, serviceName: string) {
  const services = parsedData?.services || {};
  for (const [key, value] of Object.entries(services)) {
    if (key.toLowerCase().includes(serviceName.toLowerCase())) {
      return value as { total: number };
    }
  }
  return null;
}

function round(num: number): number {
  return Math.round(num * 100) / 100;
}
```

**Test:** Invoices calculated correctly in browser

---

### Phase 6: Cloud Scheduler Setup

**Goal:** Automated scraping every 3 days

```bash
# Create service account for scheduler
gcloud iam service-accounts create scheduler-sa \
    --display-name="Cloud Scheduler Service Account"

# Grant invoker permission
gcloud run services add-iam-policy-binding scraper \
    --member="serviceAccount:scheduler-sa@utilitysplitter.iam.gserviceaccount.com" \
    --role="roles/run.invoker"

# Create scheduled job
gcloud scheduler jobs create http scrape-bills-job \
    --location=us-central1 \
    --schedule="0 6 */3 * *" \
    --uri="https://scraper-HASH-uc.a.run.app/scrape" \
    --http-method=POST \
    --oidc-service-account-email="scheduler-sa@utilitysplitter.iam.gserviceaccount.com"
```

---

### Phase 7: Email Integration

**Goal:** Send invoices via Gmail API

Options:

1. **Client-side Gmail API** - User authorizes, tokens stored in Firestore
2. **Cloud Function** - Server-side email sending

**Recommended: Cloud Function for sending emails**

**functions/src/index.ts:**

```typescript
import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { google } from "googleapis";

admin.initializeApp();

export const sendInvoice = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Must be logged in"
    );
  }

  const { billId, unitId } = data;

  // Get invoice from Firestore
  const invoiceRef = admin
    .firestore()
    .collection("bills")
    .doc(billId)
    .collection("invoices")
    .doc(unitId);

  const invoice = await invoiceRef.get();
  if (!invoice.exists) {
    throw new functions.https.HttpsError("not-found", "Invoice not found");
  }

  // Get Gmail token from Firestore
  const tokenDoc = await admin
    .firestore()
    .collection("gmail_tokens")
    .doc("default")
    .get();
  const tokens = tokenDoc.data();

  // Send email via Gmail API
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials(tokens);

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  // ... compose and send email

  // Update invoice status
  await invoiceRef.update({
    status: "SENT",
    sent_at: admin.firestore.Timestamp.now(),
  });

  return { success: true };
});
```

---

## Migration Checklist

- [x] Create React app with Vite (`web/` directory)
- [x] Set up Firebase SDK (Auth, Firestore, Storage) - `web/src/firebase.ts`
- [x] Build Units CRUD pages - `web/src/pages/Units.tsx`, `UnitEdit.tsx`
- [x] Build Bills dashboard - `web/src/pages/Bills.tsx`
- [x] Build Bill detail/review page - `web/src/pages/BillDetail.tsx`
- [x] Implement invoice calculator (client-side) - `web/src/services/invoiceCalculator.ts`
- [x] Create Cloud Run scraper service - `scraper/` directory with modular scrapers
- [x] Create Cloud Functions for email/reminders - `functions/src/index.ts`
- [ ] Set up Cloud Scheduler
- [ ] Deploy to Firebase Hosting
- [ ] Deploy Cloud Run scraper
- [ ] Deploy Cloud Functions
- [ ] Test full end-to-end flow
- [ ] Migrate existing SQLite data to Firestore
- [ ] Set up monitoring/alerts

## Cost Estimate: $0-3/month

| Service          | Usage                 | Cost      |
| ---------------- | --------------------- | --------- |
| Firebase Hosting | ~1GB transfer         | Free tier |
| Firestore        | <1MB data             | Free tier |
| Firebase Storage | <10MB PDFs            | Free tier |
| Cloud Run        | ~20 invocations/month | Free tier |
| Cloud Scheduler  | 1 job                 | Free tier |
| Cloud Functions  | ~50 calls/month       | Free tier |
| **Total**        |                       | **$0**    |

## Files to Delete (from current codebase)

```
# All FastAPI code
src/main.py
src/web/
src/services/
src/db/
src/core/
src/jobs/
src/commands/

# Keep for reference during migration, then delete
alembic.ini
docker-compose.yml
Dockerfile (replace with scraper Dockerfile)
```

## Files to Keep (adapt)

- `src/services/bill_manager.py` → `scraper/scraper.py` (Playwright logic)
- PDF parsing regex → `scraper/parser.py`
- Invoice calculation → `web/src/services/invoiceCalculator.ts`
