# AGENTS.md

This file provides comprehensive guidance to AI assistants when working with this repository.

## Table of Contents

1. [Project Overview](#project-overview)
2. [Architecture](#architecture)
3. [Project Structure](#project-structure)
4. [Technology Stack](#technology-stack)
5. [Key Files Reference](#key-files-reference)
6. [Invoice Calculation & Rounding](#invoice-calculation--rounding)
7. [Data Models](#data-models)
8. [Cloud Functions](#cloud-functions)
9. [Scraper Service](#scraper-service)
10. [Configuration](#configuration)
11. [Development Commands](#development-commands)
12. [Deployment](#deployment)
13. [Workflows](#workflows)
14. [Troubleshooting](#troubleshooting)

---

## Project Overview

**UtilitySplitter** is an automated HOA utility billing system that:

- **Scrapes** utility bills from Seattle Utilities automatically
- **Parses** PDF bills to extract service charges (water, sewer, garbage, etc.)
- **Fetches** submeter readings from NextCentury Meters smart meter system
- **Calculates** per-unit invoices based on submeter readings and square footage
- **Sends** invoice emails to tenants via Gmail API
- **Tracks** payments and sends automated reminders

### Key Concepts

| Concept          | Description                                                |
| ---------------- | ---------------------------------------------------------- |
| **Master Meter** | Seattle Utilities meter for entire property, billed in CCF |
| **Submeter**     | NextCentury smart meter per unit, measures in gallons      |
| **CCF**          | Centum Cubic Feet (100 cubic feet = 748 gallons)           |
| **Common Area**  | Unmetered water usage (hallways, landscaping, etc.)        |
| **Adjustment**   | Bill credits/debits requiring manual unit assignment       |
| **Solid Waste**  | Garbage, Food/Yard Waste (compost), and Recycle services   |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Firebase Hosting                                 │
│                    https://utilitysplitter.web.app                       │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                     React SPA (Vite + TypeScript)                  │  │
│  │        Dashboard │ Bills │ Units │ Settings │ Login                │  │
│  │                    Custom React Hooks                              │  │
│  │        (useAuth, useBills, useUnits, useUsers)                    │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                           Firebase Services                               │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐  │
│  │   Firestore     │  │  Firebase Auth  │  │    Cloud Storage        │  │
│  │  - bills/       │  │  Google Sign-In │  │  - bills/*.pdf          │  │
│  │  - units/       │  │                 │  │                         │  │
│  │  - users/       │  │                 │  │                         │  │
│  │  - settings/    │  │                 │  │                         │  │
│  └────────┬────────┘  └─────────────────┘  └─────────────────────────┘  │
│           │                                                               │
│  ┌────────┴────────────────────────────────────────────────────────────┐ │
│  │                       Cloud Functions                                │ │
│  │  HTTPS Callable:                    Scheduled:                       │ │
│  │  - getGmailAuthUrl                  - sendReminders (daily 9 AM)     │ │
│  │  - disconnectGmail                  - triggerScraper (every 3 days)  │ │
│  │  - sendInvoiceEmail                                                  │ │
│  │  - sendAllInvoices                  HTTP:                            │ │
│  │  - triggerScraperManual             - gmailOAuthCallback             │ │
│  │  - fetchMeterReadings               - populateBillReadings           │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                      Cloud Run (Scraper Service)                          │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │                      Flask Application                            │    │
│  │  Endpoints:                                                       │    │
│  │  - GET  /health                                                   │    │
│  │  - POST /scrape?type=seattle_utilities|nextcentury_meters|all     │    │
│  │  - POST /readings (fetch readings for specific date range)        │    │
│  │                                                                   │    │
│  │  Scrapers: SeattleUtilitiesScraper, NextCenturyMetersScraper     │    │
│  └──────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                        External Services                                  │
│  Seattle Utilities (myutilities.seattle.gov)                             │
│  NextCentury Meters (app.nextcenturymeters.com)                          │
│  Gmail API (via googleapis)                                              │
└──────────────────────────────────────────────────────────────────────────┘
```

### Request Flow: Bill Scraping (Async Architecture)

The scraper uses an **asynchronous fire-and-forget pattern** to avoid timeouts:

```
Cloud Scheduler → triggerScraper Cloud Function → POST /scrape
    ↓
Cloud Run Scraper → Seattle Utilities Portal → PDF → BillParser
    ↓
Firestore: bills/{billId} (bill data saved)
    ↓
Fire-and-forget POST to populateBillReadings (1-second timeout)
    ↓
Cloud Function → POST /readings → NextCentury API
    ↓
Firestore: bills/{billId}.meter_readings + readings/ subcollection
    ↓
Frontend auto-updates via Firestore real-time listeners
```

**Key Design Decision:** The scraper triggers meter reading population asynchronously via `populateBillReadings` HTTP endpoint instead of processing synchronously. This prevents 502/504 timeout errors when multiple bills are scraped at once.

---

## Project Structure

```
/
├── AGENTS.md                # This documentation file
├── firebase.json            # Firebase configuration
├── firestore.rules          # Firestore security rules
├── storage.rules            # Cloud Storage security rules
│
├── web/                     # React SPA (Vite + TypeScript)
│   └── src/
│       ├── firebase.ts      # Firebase SDK initialization
│       ├── components/      # React components (Layout.tsx)
│       ├── hooks/           # Custom hooks (useAuth, useBills, useUnits, useUsers)
│       ├── pages/           # Page components
│       ├── services/        # Business logic (invoiceCalculator.ts)
│       └── types/           # TypeScript definitions
│
├── functions/               # Firebase Cloud Functions (TypeScript)
│   └── src/index.ts         # All Cloud Functions
│
└── scraper/                 # Cloud Run Scraper Service (Python)
    ├── main.py              # Flask app & orchestration
    ├── parser.py            # PDF bill parser
    └── scrapers/            # Browser automation (Playwright)
        ├── seattle_utilities.py
        └── nextcentury_meters.py
```

---

## Technology Stack

### Frontend (web/)

| Technology | Version | Purpose |
| --- | --- | --- |
| React | 19.x | UI framework |
| TypeScript | 5.x | Type safety |
| Vite | 7.x | Build tool |
| Firebase SDK | 12.x | Auth, Firestore, Storage, Functions |
| Tailwind CSS | 3.x | Styling |

### Cloud Functions (functions/)

| Technology | Version | Purpose |
| --- | --- | --- |
| Node.js | 20 | Runtime |
| firebase-functions | 5.x | Function framework |
| googleapis | 140.x | Gmail API |
| nodemailer | 6.x | Email sending |

### Scraper (scraper/)

| Technology | Version | Purpose |
| --- | --- | --- |
| Python | 3.13 | Runtime |
| Flask | 3.x | Web framework |
| Playwright | 1.x | Browser automation |
| PyPDF2 | 3.x | PDF parsing |

---

## Key Files Reference

### Web Application

| File | Purpose |
| --- | --- |
| [`web/src/firebase.ts`](web/src/firebase.ts) | Firebase SDK initialization |
| [`web/src/hooks/useAuth.ts`](web/src/hooks/useAuth.ts) | Authentication state & Google Sign-In |
| [`web/src/hooks/useBills.ts`](web/src/hooks/useBills.ts) | Bill CRUD, meter reading fetch, invoice operations |
| [`web/src/hooks/useUnits.ts`](web/src/hooks/useUnits.ts) | Unit CRUD operations |
| [`web/src/hooks/useUsers.ts`](web/src/hooks/useUsers.ts) | User management & roles |
| [`web/src/services/invoiceCalculator.ts`](web/src/services/invoiceCalculator.ts) | Invoice calculation with Hamilton's method |
| [`web/src/types/index.ts`](web/src/types/index.ts) | TypeScript type definitions |
| [`web/src/pages/BillDetail.tsx`](web/src/pages/BillDetail.tsx) | Bill detail page with readings, adjustments, invoices |
| [`web/src/pages/Settings.tsx`](web/src/pages/Settings.tsx) | Admin settings page |

### Cloud Functions

| File | Purpose |
| --- | --- |
| [`functions/src/index.ts`](functions/src/index.ts) | All Cloud Functions (Gmail OAuth, email, scraper triggers, meter readings) |

### Scraper Service

| File | Purpose |
| --- | --- |
| [`scraper/main.py`](scraper/main.py) | Flask app, endpoints, bill processing orchestration |
| [`scraper/parser.py`](scraper/parser.py) | PDF bill parser with regex patterns |
| [`scraper/scrapers/seattle_utilities.py`](scraper/scrapers/seattle_utilities.py) | Seattle Utilities scraper (Playwright) |
| [`scraper/scrapers/nextcentury_meters.py`](scraper/scrapers/nextcentury_meters.py) | NextCentury Meters scraper (Playwright + API) |

### Configuration

| File | Purpose |
| --- | --- |
| [`firebase.json`](firebase.json) | Firebase project configuration |
| [`firestore.rules`](firestore.rules) | Firestore security rules |
| [`storage.rules`](storage.rules) | Cloud Storage security rules |

---

## Invoice Calculation & Rounding

The invoice calculator ([`web/src/services/invoiceCalculator.ts`](web/src/services/invoiceCalculator.ts)) uses several techniques to ensure **fair distribution** and **exact totals** when splitting utility bills among units.

### Hamilton's Method (Largest Remainder)

When dividing a dollar amount among units, floating-point division rarely produces exact cents. For example, splitting $100.00 among 3 units gives $33.333... each, which rounds to $33.33 × 3 = $99.99 — losing a penny.

**Hamilton's method** (also called "largest remainder method") solves this:

1. Convert total to integer cents (e.g., $100.00 → 10000 cents)
2. Calculate each unit's share as a decimal of cents
3. Give each unit the floor of their share (guaranteed ≤ total)
4. Distribute remaining cents one-by-one to units with largest fractional remainders

```typescript
// Example: $100.00 split 3 ways
// Each gets floor(10000/3) = 3333 cents = $33.33
// Remainder: 10000 - (3333 × 3) = 1 cent
// Unit with largest remainder (0.333...) gets the extra cent
// Result: $33.34, $33.33, $33.33 = $100.00 exactly
```

### Integer Cents Arithmetic

All calculations use **integer cents** internally to avoid floating-point precision errors:

```typescript
// ❌ Bad: floating-point accumulation
let total = 0;
items.forEach(item => total += item.cost); // May produce 99.99999999

// ✅ Good: integer cents
let totalCents = 0;
items.forEach(item => totalCents += Math.round(item.cost * 100));
const total = totalCents / 100; // Exact
```

### Zero-Usage Fallback

When a unit has **zero water usage** (e.g., vacant unit), it would normally receive $0 for usage-based charges. To ensure fairness, the calculator falls back to **square footage weighting**:

- If a unit has 0 gallons usage but the bill has usage-based charges
- That unit's share is calculated by sqft proportion instead
- Other units with actual usage are still weighted by their usage

This prevents the edge case where one vacant unit pays nothing while others pay more.

### Distribution Categories

Charges are distributed using different weights based on type:

| Category | Distribution Method |
| --- | --- |
| Water (usage-based) | By submeter gallons (with sqft fallback for 0-usage units) |
| Water (base charges) | By square footage |
| Sewer | By submeter gallons (with sqft fallback) |
| Drainage | By square footage |
| Solid Waste | Manually assigned per-unit |
| Adjustments | Split equally among assigned units |

### Solid Waste Validation

Solid waste items (garbage, compost, recycle) require manual assignment to units. The validation system distinguishes between:

- **Errors (blocking)**: Total assigned doesn't match bill total
- **Warnings (non-blocking)**: Missing garbage or compost assignment for a unit

This allows bills to be approved even if a unit doesn't have all service types assigned (e.g., a unit that doesn't have compost service).

### UI Behavior

- **Adjustments** are sorted by date (oldest first, nulls at end) in BillDetail.tsx
- **Readiness check** shows both errors and warnings, but only errors block approval
- **Solid waste assignment** uses fair cost distribution when items have count > 1

---

## Data Models

All TypeScript types are defined in [`web/src/types/index.ts`](web/src/types/index.ts).

### Firestore Collections

#### `bills/` - Utility Bills

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Document ID (format: `YYYY-MM-DD`) |
| `bill_date` | string | Bill date (MM/DD/YYYY) |
| `due_date` | string | Due date (Month DD, YYYY) |
| `total_amount` | number | Total bill amount |
| `pdf_url` | string | Cloud Storage URL |
| `status` | BillStatus | NEW, NEEDS_REVIEW, PENDING_APPROVAL, APPROVED, INVOICED |
| `has_adjustments` | boolean | True if bill has adjustments |
| `services` | Record | Service data (Water, Sewer, Drainage, Solid Waste) |
| `meter_readings` | Record | Auto-populated meter readings from NextCentury |
| `meter_readings_fetched_at` | Timestamp | When readings were fetched |
| `created_at` | Timestamp | Creation time |

**Subcollections:**
- `bills/{billId}/readings/{unitId}` - Per-unit meter readings
- `bills/{billId}/adjustments/{id}` - Bill adjustments requiring assignment
- `bills/{billId}/invoices/{unitId}` - Generated invoices
- `bills/{billId}/solid_waste_assignments/{unitId}` - Solid waste assignments

#### `units/` - Property Units

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Auto-generated ID |
| `name` | string | Display name (e.g., "Unit 401") |
| `sqft` | number | Square footage |
| `submeter_id` | string | Submeter identifier |
| `email` | string | Tenant email |
| `solid_waste_defaults` | object | Default garbage/recycling/compost sizes |

**Note:** Unit names must follow pattern "Unit XXX" where XXX is a number for NextCentury matching.

#### `users/` - App Users

Document ID is the user's email (lowercase).

| Field | Type | Description |
| --- | --- | --- |
| `email` | string | Email address |
| `role` | UserRole | "admin" or "member" |
| `created_at` | Timestamp | Creation time |

#### `settings/` - Application Settings

- `settings/utility_credentials` - Seattle Utilities & NextCentury login credentials
- `settings/gmail_token` - Gmail OAuth tokens
- `settings/community` - HOA name, reminder days
- `settings/scraper_status` - Current scraper run status
- `settings/latest_readings` - Latest meter readings cache

---

## Cloud Functions

All functions defined in [`functions/src/index.ts`](functions/src/index.ts).

### HTTPS Callable Functions

| Function | Purpose | Parameters |
| --- | --- | --- |
| `getGmailAuthUrl` | Generate Gmail OAuth URL | none |
| `disconnectGmail` | Remove Gmail OAuth tokens | none |
| `sendInvoiceEmail` | Send single invoice | { billId, invoiceId } |
| `sendAllInvoices` | Send all draft invoices | { billId } |
| `triggerScraperManual` | Manually trigger scraper | { type? } |
| `fetchMeterReadings` | Fetch readings for bill period | { billId, startDate, endDate } |

### HTTP Endpoints

| Endpoint | Purpose | Auth |
| --- | --- | --- |
| `gmailOAuthCallback` | Gmail OAuth callback | OAuth state |
| `populateBillReadings` | Populate readings for a bill (called by scraper) | SCRAPER_SECRET header |

### Scheduled Functions

| Function | Schedule | Purpose |
| --- | --- | --- |
| `sendReminders` | Daily 9 AM Pacific | Send payment reminders |
| `triggerScraper` | Every 3 days 6 AM Pacific | Auto-scrape bills |

---

## Scraper Service

The scraper is a Flask application running on Cloud Run. See [`scraper/main.py`](scraper/main.py).

### Endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | Health check |
| `/scrape` | POST | Scrape bills and/or readings |
| `/readings` | POST | Fetch readings for date range |

### Bill Processing Flow

1. **Scrape bills** - Downloads PDFs from Seattle Utilities
2. **Parse bills** - Extracts structured data using [`parser.py`](scraper/parser.py)
3. **Save to Firestore** - Creates bill document and adjustments
4. **Trigger meter readings** - Fire-and-forget POST to `populateBillReadings` Cloud Function
5. **Cloud Function fetches readings** - Calls `/readings` endpoint, saves to Firestore
6. **Frontend updates** - Real-time Firestore listeners update UI automatically

### Scrapers

- [`seattle_utilities.py`](scraper/scrapers/seattle_utilities.py) - Playwright-based scraper for Seattle Utilities portal
- [`nextcentury_meters.py`](scraper/scrapers/nextcentury_meters.py) - Playwright login + REST API for NextCentury Meters

---

## Configuration

### Environment Variables

#### Functions (`functions/.env`)

```bash
SCRAPER_URL=https://utility-scraper-xxx.us-central1.run.app
GMAIL_CLIENT_ID=xxx.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=GOCSPX-xxx
SCRAPER_SECRET=<shared-secret-for-scraper-auth>
```

#### Scraper (Cloud Run environment)

```bash
SCRAPER_SECRET=<same-shared-secret>
```

#### Web (`web/.env.local`)

```bash
VITE_FIREBASE_API_KEY=xxx
VITE_FIREBASE_AUTH_DOMAIN=utilitysplitter.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=utilitysplitter
VITE_FIREBASE_STORAGE_BUCKET=utilitysplitter.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=xxx
VITE_FIREBASE_APP_ID=xxx
VITE_BOOTSTRAP_ADMIN_EMAIL=admin@example.com
```

### Key URLs

| Service | URL |
| --- | --- |
| Web App | https://utilitysplitter.web.app |
| Cloud Run Scraper | https://utility-scraper-xxx.us-central1.run.app |
| Gmail OAuth Callback | https://us-central1-utilitysplitter.cloudfunctions.net/gmailOAuthCallback |

---

## Development Commands

### Web Application

```bash
cd web
npm install
npm run dev          # Start dev server (http://localhost:5173)
npm run build        # Production build
npm run lint         # Lint code
```

### Cloud Functions

```bash
cd functions
npm install
npm run build        # Compile TypeScript
npm run serve        # Start emulators
firebase deploy --only functions
```

### Scraper

```bash
cd scraper
uv sync                           # Install dependencies
uv run playwright install chromium
uv run flask run --port 8080      # Run locally
gcloud run deploy utility-scraper --source . --region us-central1
```

### Firebase CLI

```bash
firebase login
firebase use utilitysplitter
firebase deploy                   # Deploy all
firebase deploy --only hosting    # Deploy web only
firebase deploy --only functions  # Deploy functions only
```

---

## Deployment

### Full Deployment

```bash
# 1. Build web app
cd web && npm install && npm run build

# 2. Build functions
cd ../functions && npm install && npm run build

# 3. Deploy Firebase (hosting + functions + rules)
cd .. && firebase deploy

# 4. Deploy scraper (if changed)
cd scraper
gcloud run deploy utility-scraper \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 1Gi \
  --timeout 300 \
  --set-env-vars "SCRAPER_SECRET=xxx"
```

### Setting SCRAPER_SECRET

The scraper and Cloud Functions must share a secret for authentication:

```bash
# Generate a secret
openssl rand -base64 32

# Set in Cloud Functions
firebase functions:secrets:set SCRAPER_SECRET

# Set in Cloud Run
gcloud run services update utility-scraper \
  --set-env-vars "SCRAPER_SECRET=xxx"
```

---

## Workflows

### Bill Processing Workflow

1. **SCRAPE** - Automatic (every 3 days) or manual trigger
2. **BILL CREATED** - PDF parsed, bill saved to Firestore
3. **METER READINGS AUTO-POPULATED** - Fire-and-forget to Cloud Function
4. **REVIEW** - User verifies readings, assigns adjustments/solid waste
5. **APPROVE & SEND** - Invoices calculated and emailed
6. **TRACK PAYMENTS** - Mark invoices as paid, automated reminders

### First-Time Setup

1. Deploy Firebase (hosting, functions, rules)
2. Deploy Cloud Run scraper
3. Set SCRAPER_SECRET in both environments
4. Sign in with bootstrap admin email
5. Navigate to Settings → Initialize as Admin
6. Configure utility credentials (Seattle Utilities, NextCentury)
7. Connect Gmail for sending invoices
8. Add property units

---

## Troubleshooting

### Common Issues

**Member account stuck on loading:**
- Check if user email exists in `users/` collection (case-sensitive!)
- Ensure email is lowercase in Firestore

**Meter readings not populating:**
- Check `populateBillReadings` function logs
- Verify SCRAPER_SECRET matches in both environments
- Check NextCentury credentials in settings

**Scraper timeouts (502/504):**
- The async architecture should prevent this
- If still occurring, check Cloud Run memory/timeout settings

**Invoice totals don't match bill:**
- Uses Hamilton's method for fair rounding
- Check if all solid waste items are assigned
- Check if all adjustments are assigned

### Viewing Logs

```bash
# Cloud Functions
firebase functions:log --only populateBillReadings

# Cloud Run
gcloud run logs read utility-scraper --region us-central1