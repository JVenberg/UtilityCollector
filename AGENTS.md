# AGENTS.md

This file provides comprehensive guidance to AI assistants when working with this repository.

## Table of Contents

1. [Maintaining This Documentation](#maintaining-this-documentation)
2. [Project Overview](#project-overview)
3. [Architecture](#architecture)
4. [Project Structure](#project-structure)
5. [Technology Stack](#technology-stack)
6. [Data Models](#data-models)
7. [Web Application](#web-application)
8. [Cloud Functions](#cloud-functions)
9. [Scraper Service](#scraper-service)
10. [Security Rules](#security-rules)
11. [Configuration](#configuration)
12. [Development Commands](#development-commands)
13. [Deployment](#deployment)
14. [Workflows](#workflows)
15. [Troubleshooting](#troubleshooting)
16. [Code Patterns and Conventions](#code-patterns-and-conventions)

---

## Maintaining This Documentation

**IMPORTANT: This file must be kept up-to-date as the codebase evolves.**

### When to Update AGENTS.md

Update this documentation whenever you make changes that affect:

1. **Project Structure** - Adding, renaming, or removing files/directories
2. **Data Models** - Modifying Firestore collections, adding/removing fields, changing types
3. **API Changes** - Adding new Cloud Functions, modifying endpoints, changing request/response formats
4. **Configuration** - New environment variables, Firebase settings, or deployment configurations
5. **Dependencies** - Major version updates or new packages that affect architecture
6. **Workflows** - Changes to bill processing, authentication, or other business logic flows
7. **Security Rules** - Any modifications to Firestore or Storage security rules

### How to Update

When making code changes, follow these steps:

1. **Complete your code changes first** - Ensure the feature/fix is working
2. **Identify affected sections** - Review the Table of Contents to find relevant sections
3. **Update documentation inline** - Modify the specific sections that changed
4. **Update version numbers** - If dependency versions changed, update the Technology Stack tables
5. **Add new sections if needed** - For entirely new features, add appropriate documentation

### Documentation Standards

- **Code blocks**: Use appropriate language identifiers (typescript, python, bash, json)
- **File references**: Use relative paths from project root (e.g., `web/src/hooks/useAuth.ts`)
- **Type definitions**: Include full TypeScript interfaces for all data models
- **API documentation**: Document request/response formats for all endpoints
- **Keep examples current**: Update example commands and code snippets when APIs change

### Checklist for Updates

Before completing a task, verify:

- [ ] All new files are documented in Project Structure
- [ ] New types/interfaces are added to Data Models
- [ ] New functions/hooks have their signatures documented
- [ ] New environment variables are listed in Configuration
- [ ] Changes to workflows are reflected in the Workflows section
- [ ] Any new commands are added to Development Commands

---

## Project Overview

**UtilitySplitter** is an automated HOA utility billing system that:

- **Scrapes** utility bills from Seattle Utilities automatically
- **Parses** PDF bills to extract service charges (water, sewer, garbage, etc.)
- **Fetches** submeter readings from NextCentury Meters smart meter system
- **Calculates** per-unit invoices based on submeter readings and square footage
- **Sends** invoice emails to tenants via Gmail API
- **Tracks** payments and sends automated reminders

### Key Features

- React SPA frontend with Firebase SDK (Firestore, Auth, Storage)
- Cloud Functions for email sending and scheduled tasks
- Cloud Run for Playwright-based web scraping
- Support for Seattle Utilities and NextCentury Meters
- Role-based access control (admin/member)
- Gmail OAuth integration for sending invoices
- Auto-population of meter readings when new bills are scraped
- Manual "Refresh from Meters" functionality on bill detail page

### Business Logic Summary

1. **Bill Source**: Seattle Utilities sends a master bill for the entire property (water, sewer, garbage, drainage)
2. **Submeter Source**: NextCentury Meters provides individual water usage per unit via smart meters
3. **Calculation**: Each unit pays proportionally based on their water usage ratio, with common area split by square footage
4. **Delivery**: Invoices are emailed to tenants, with payment tracking and automated reminders

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
│  │                                                                    │  │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌──────────┐  ┌────────┐ │  │
│  │  │Dashboard│  │  Bills  │  │  Units  │  │ Settings │  │ Login  │ │  │
│  │  └────┬────┘  └────┬────┘  └────┬────┘  └────┬─────┘  └───┬────┘ │  │
│  │       │            │            │             │            │      │  │
│  │       └────────────┴────────────┴─────────────┴────────────┘      │  │
│  │                              │                                     │  │
│  │                    Custom React Hooks                              │  │
│  │        (useAuth, useBills, useUnits, useUsers)                    │  │
│  └───────────────────────────────┬───────────────────────────────────┘  │
└──────────────────────────────────┼──────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                           Firebase Services                               │
│                                                                           │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐  │
│  │   Firestore     │  │  Firebase Auth  │  │    Cloud Storage        │  │
│  │                 │  │                 │  │                         │  │
│  │  - bills/       │  │  Google Sign-In │  │  - bills/*.pdf          │  │
│  │  - units/       │  │                 │  │                         │  │
│  │  - users/       │  │                 │  │                         │  │
│  │  - settings/    │  │                 │  │                         │  │
│  └────────┬────────┘  └─────────────────┘  └─────────────────────────┘  │
│           │                                                               │
│  ┌────────┴────────────────────────────────────────────────────────────┐ │
│  │                       Cloud Functions                                │ │
│  │                                                                      │ │
│  │  HTTPS Callable:                    Scheduled:                       │ │
│  │  - getGmailAuthUrl                  - sendReminders (daily 9 AM)     │ │
│  │  - disconnectGmail                  - triggerScraper (every 3 days)  │ │
│  │  - sendInvoiceEmail                                                  │ │
│  │  - sendAllInvoices                  HTTP:                            │ │
│  │  - triggerScraperManual             - gmailOAuthCallback             │ │
│  │  - fetchMeterReadings                                                │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                      Cloud Run (Scraper Service)                          │
│               https://utility-scraper-xxx.us-central1.run.app            │
│                                                                           │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │                      Flask Application                            │    │
│  │                                                                   │    │
│  │  Endpoints:                                                       │    │
│  │  - GET  /health                                                   │    │
│  │  - POST /scrape?type=seattle_utilities|nextcentury_meters|all     │    │
│  │  - POST /readings (fetch readings for specific date range)        │    │
│  │                                                                   │    │
│  │  Scrapers:                                                        │    │
│  │  ┌─────────────────────┐  ┌─────────────────────┐                │    │
│  │  │ SeattleUtilities    │  │ NextCenturyMeters   │                │    │
│  │  │ Scraper (Playwright)│  │ Scraper (Playwright)│                │    │
│  │  │                     │  │                     │                │    │
│  │  │ - Login to portal   │  │ - Login to portal   │                │    │
│  │  │ - Download PDFs     │  │ - Extract JWT token │                │    │
│  │  │ - Parse bills       │  │ - Call REST API     │                │    │
│  │  └─────────────────────┘  └─────────────────────┘                │    │
│  └──────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                        External Services                                  │
│                                                                           │
│  ┌─────────────────────┐  ┌─────────────────────┐                        │
│  │  Seattle Utilities  │  │  NextCentury Meters │                        │
│  │  myutilities.       │  │  app.nextcentury    │                        │
│  │  seattle.gov        │  │  meters.com         │                        │
│  └─────────────────────┘  └─────────────────────┘                        │
│                                                                           │
│  ┌─────────────────────┐                                                 │
│  │  Gmail API          │ ◄── OAuth2 for sending invoice emails           │
│  │  (via googleapis)   │                                                 │
│  └─────────────────────┘                                                 │
└──────────────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Bill Scraping**: Cloud Scheduler → Cloud Function → Cloud Run Scraper → Seattle Utilities Portal → PDF downloaded → Parsed → Stored in Firestore + Cloud Storage
2. **Meter Readings**: Scraper or Manual Trigger → Cloud Run Scraper → NextCentury API → Readings stored in Firestore
3. **Invoice Generation**: User reviews bill → Enters/confirms readings → System calculates invoices → User approves → Emails sent via Gmail API
4. **Payment Tracking**: User marks invoices as paid → System tracks status → Sends reminders for unpaid invoices

### Request Flow Details

**Bill Scraping Request Flow:**

```
Cloud Scheduler (cron)
    ↓
triggerScraper Cloud Function
    ↓ POST /scrape
Cloud Run Scraper
    ↓ Playwright
Seattle Utilities Portal
    ↓ PDF
BillParser.parse()
    ↓ parsed_data
Firestore: bills/{billId}
    ↓ auto_populate_readings()
NextCentury Meters API
    ↓ readings
Firestore: bills/{billId}/readings/{unitId}
```

**Meter Reading Fetch Flow:**

```
BillDetail.tsx
    ↓ fetchMeterReadings()
fetchMeterReadings Cloud Function
    ↓ POST /readings
Cloud Run Scraper
    ↓ NextCenturyMetersScraper
NextCentury API
    ↓ DailyReads
Transform to gallons
    ↓
Return to client
```

---

## Project Structure

```
/
├── AGENTS.md                # This documentation file
├── README.md                # Project readme
├── firebase.json            # Firebase configuration (hosting, functions, rules)
├── firestore.rules          # Firestore security rules
├── firestore.indexes.json   # Firestore composite indexes
├── storage.rules            # Cloud Storage security rules
├── .firebaserc              # Firebase project aliases
├── .nvmrc                   # Node.js version (20)
├── .env.example             # Environment variable template
│
├── web/                     # React SPA (Vite + TypeScript)
│   ├── package.json         # Dependencies: react, firebase, react-router-dom
│   ├── package-lock.json    # Locked dependency versions
│   ├── vite.config.ts       # Vite configuration
│   ├── tsconfig.json        # TypeScript configuration (references)
│   ├── tsconfig.app.json    # App-specific TypeScript config
│   ├── tsconfig.node.json   # Node-specific TypeScript config
│   ├── tailwind.config.js   # Tailwind CSS configuration
│   ├── postcss.config.js    # PostCSS configuration
│   ├── eslint.config.js     # ESLint configuration
│   ├── index.html           # HTML entry point
│   ├── .env.example         # Frontend environment variables template
│   │
│   ├── public/
│   │   └── vite.svg         # Vite logo
│   │
│   └── src/
│       ├── main.tsx         # React entry point (ReactDOM.createRoot)
│       ├── App.tsx          # Root component with routing
│       ├── App.css          # App-specific styles
│       ├── firebase.ts      # Firebase SDK initialization + exports
│       ├── index.css        # Global styles (Tailwind imports)
│       │
│       ├── assets/
│       │   └── react.svg    # React logo
│       │
│       ├── components/
│       │   └── Layout.tsx   # Main layout with navigation sidebar
│       │
│       ├── hooks/           # Custom React hooks
│       │   ├── useAuth.ts   # Authentication state & methods
│       │   ├── useBills.ts  # Bill CRUD operations + meter reading fetch
│       │   ├── useUnits.ts  # Unit CRUD operations
│       │   └── useUsers.ts  # User management & roles
│       │
│       ├── pages/
│       │   ├── Login.tsx    # Login page (Google Sign-In)
│       │   ├── Dashboard.tsx# Dashboard with bill summary
│       │   ├── Bills.tsx    # Bills list with status filtering
│       │   ├── BillDetail.tsx # Bill detail, readings, adjustments, invoices
│       │   ├── Units.tsx    # Units list & creation form
│       │   ├── UnitEdit.tsx # Unit editing form
│       │   └── Settings.tsx # Settings (credentials, Gmail, users, scraper)
│       │
│       ├── services/
│       │   └── invoiceCalculator.ts  # Invoice calculation logic
│       │
│       └── types/
│           └── index.ts     # TypeScript type definitions
│
├── functions/               # Firebase Cloud Functions (TypeScript)
│   ├── package.json         # Dependencies: firebase-functions, googleapis, nodemailer
│   ├── package-lock.json    # Locked dependency versions
│   ├── tsconfig.json        # TypeScript configuration
│   │
│   ├── src/
│   │   └── index.ts         # All Cloud Functions (Gmail OAuth, email, scraper triggers)
│   │
│   └── lib/                 # Compiled JavaScript output
│       ├── index.js
│       └── index.js.map
│
├── scraper/                 # Cloud Run Scraper Service (Python)
│   ├── Dockerfile           # Container definition (Python 3.13, Playwright)
│   ├── pyproject.toml       # Python dependencies (flask, playwright, pypdf2)
│   ├── uv.lock              # Locked Python dependencies
│   ├── main.py              # Flask application & scraper orchestration
│   ├── parser.py            # PDF bill parser with regex patterns
│   ├── test_nextcentury.py  # NextCentury scraper test script
│   │
│   ├── scrapers/
│   │   ├── __init__.py      # Package init
│   │   ├── seattle_utilities.py    # Seattle Utilities scraper
│   │   └── nextcentury_meters.py   # NextCentury Meters scraper
│   │
│   └── screenshots/         # Debug screenshots from scraper runs
│
└── public/                  # Static files for Firebase Hosting fallback
    ├── index.html           # Fallback HTML
    └── 404.html             # 404 page
```

---

## Technology Stack

### Frontend (web/)

| Technology       | Version | Purpose                                               |
| ---------------- | ------- | ----------------------------------------------------- |
| React            | 19.2    | UI framework                                          |
| TypeScript       | 5.9     | Type safety                                           |
| Vite             | 7.2     | Build tool & dev server                               |
| React Router DOM | 7.10    | Client-side routing                                   |
| Firebase SDK     | 12.6    | Firebase client (Auth, Firestore, Storage, Functions) |
| Tailwind CSS     | 3.4     | Utility-first CSS styling                             |

### Cloud Functions (functions/)

| Technology         | Version | Purpose            |
| ------------------ | ------- | ------------------ |
| Node.js            | 20      | Runtime            |
| TypeScript         | 5.4     | Type safety        |
| firebase-functions | 5.0     | Function framework |
| firebase-admin     | 12.0    | Firebase admin SDK |
| googleapis         | 140.0   | Gmail API          |
| nodemailer         | 6.9     | Email sending      |

### Scraper (scraper/)

| Technology     | Version | Purpose                        |
| -------------- | ------- | ------------------------------ |
| Python         | 3.13    | Runtime                        |
| Flask          | 3.0     | Web framework                  |
| Playwright     | 1.40    | Browser automation             |
| PyPDF2         | 3.0     | PDF parsing                    |
| firebase-admin | 6.0     | Firebase access                |
| gunicorn       | 21.0    | WSGI server (production)       |
| uv             | latest  | Fast Python package management |

---

## Data Models

### Firestore Collections

#### `bills/` - Utility Bills

The main collection for storing parsed utility bills from Seattle Utilities.

```typescript
// web/src/types/index.ts
import { Timestamp } from "firebase/firestore";

interface Bill {
  id: string; // Auto-generated Firestore document ID
  bill_date: string; // "MM/DD/YYYY" format (e.g., "12/08/2024")
  due_date: string; // "Month DD, YYYY" format (e.g., "January 13, 2025")
  total_amount: number; // Total bill amount in dollars
  pdf_url: string; // Cloud Storage URL: gs://bucket/bills/date.pdf
  status: BillStatus; // Workflow status (see below)
  has_adjustments: boolean; // True if bill contains adjustment line items
  parsed_data: ParsedBillData; // Structured data extracted from PDF
  created_at: Timestamp; // When scraper added the bill
  approved_at: Timestamp | null; // When bill was approved
  approved_by: string | null; // User ID who approved
}

type BillStatus =
  | "NEW" // Just scraped, may need readings entered
  | "NEEDS_REVIEW" // Has adjustments that need unit assignment
  | "PENDING_APPROVAL" // Ready for review and approval
  | "APPROVED" // Approved but not yet sent
  | "INVOICED"; // Invoices sent to tenants

interface ParsedBillData {
  due_date: string; // Extracted due date
  total: number; // Extracted total amount
  services: Record<string, ServiceData>; // Service name → data
  // Service keys: "Water", "Sewer", "Drainage", "Garbage", "Recycling"
  // May also include: "Water Adjustment", "Sewer Adjustment", etc.
}

interface ServiceData {
  total: number; // Total charge for this service
  parts: ServicePart[]; // Line item groups (may have multiple periods/meters)
}

interface ServicePart {
  items: BillItem[]; // Individual line items
  start_date?: string; // Period start (e.g., "Dec 01, 2024")
  end_date?: string; // Period end (e.g., "Dec 31, 2024")
  usage?: number; // Usage in CCF for water/sewer
  start_meter?: number; // Starting meter reading
  end_meter?: number; // Ending meter reading
  meter_number?: string; // Meter ID
  service_category?: string; // Service category code
}

interface BillItem {
  description: string; // Line item description
  cost: number; // Cost in dollars
  date?: string; // Transaction date if applicable
  usage?: number; // Usage in CCF if applicable
  rate?: number; // Rate per CCF if applicable
  size?: number; // Trash can size in gallons (for garbage)
  count?: number; // Number of trash cans (for garbage)
  start?: string; // Period start date
  end?: string; // Period end date
}
```

**Bill Status State Machine:**

```
           ┌─────────────────────────────────────────┐
           │                                         │
           ▼                                         │
┌─────────────────┐     ┌─────────────────────┐     │
│      NEW        │────▶│    NEEDS_REVIEW     │─────┘
│  (no adj)       │     │   (has adj)         │
└────────┬────────┘     └──────────┬──────────┘
         │                         │
         │     User assigns        │
         │     adjustments         │
         │                         │
         ▼                         ▼
    ┌─────────────────────────────────┐
    │       PENDING_APPROVAL          │
    │  (ready for review)             │
    └──────────────┬──────────────────┘
                   │
                   │ User clicks "Approve & Send"
                   │
                   ▼
    ┌─────────────────────────────────┐
    │          INVOICED               │
    │  (emails sent to tenants)       │
    └─────────────────────────────────┘
```

**Subcollections under `bills/{billId}/`:**

```typescript
// bills/{billId}/readings/{unitId}
interface Reading {
  id: string; // Same as unit_id
  unit_id: string; // Reference to units collection
  submeter_id: string; // Submeter identifier (e.g., "SM-401")
  reading: number; // Usage in GALLONS for this period
  created_at: Timestamp | null; // When reading was entered
  auto_populated?: boolean; // True if auto-populated by scraper
}

// bills/{billId}/adjustments/{adjustmentId}
interface Adjustment {
  id: string; // Auto-generated document ID
  description: string; // Adjustment description from bill
  cost: number; // Adjustment amount in dollars (can be negative)
  date: string | null; // Transaction date if specified
  assigned_unit_ids: string[]; // Units to split this adjustment among
}

// bills/{billId}/invoices/{unitId}
interface Invoice {
  id: string; // Same as unit_id
  unit_id: string; // Reference to units collection
  unit_name: string; // Unit display name (e.g., "Unit 401")
  tenant_email: string; // Email address for invoice
  amount: number; // Total invoice amount
  line_items: LineItem[]; // Breakdown of charges
  status: InvoiceStatus; // DRAFT | SENT | PAID
  sent_at: Timestamp | null; // When invoice was emailed
  paid_at: Timestamp | null; // When payment was recorded
  reminders_sent: number; // Count of reminder emails sent
}

type InvoiceStatus = "DRAFT" | "SENT" | "PAID";

interface LineItem {
  description: string; // Charge description (e.g., "Water Usage (1,500 gal)")
  amount: number; // Charge amount
}

// bills/{billId}/solid_waste_assignments/{unitId}
interface SolidWasteAssignment {
  id: string; // Same as unit_id
  unit_id: string;
  garbage_items: SolidWasteItemAssignment[]; // Garbage items assigned
  compost_items: SolidWasteItemAssignment[]; // Food/Yard Waste items assigned
  recycle_items: SolidWasteItemAssignment[]; // Recycle items assigned
  garbage_total: number; // Sum of garbage_items costs
  compost_total: number; // Sum of compost_items costs
  recycle_total: number; // Sum of recycle_items costs
  total: number; // Total solid waste cost for this unit
  auto_assigned: boolean; // True if auto-assigned from unit defaults
  created_at: Timestamp | null;
}

interface SolidWasteItemAssignment {
  item_id: string; // Reference to solid waste item in parsed_data
  description: string; // For display
  size: number; // Container size
  cost: number; // This unit's cost portion
  start_date: string;
  end_date: string;
}
```

#### `units/` - Property Units

Represents individual dwelling units in the property.

```typescript
interface Unit {
  id: string; // Auto-generated Firestore document ID
  name: string; // Display name (e.g., "Unit 401")
  sqft: number; // Square footage (for common area split calculation)
  submeter_id: string; // Submeter identifier (e.g., "SM-401")
  email: string; // Tenant email address for invoices
  trash_cans: TrashCan[]; // Legacy field, kept for backward compatibility
  solid_waste_defaults?: SolidWasteDefaults; // Structured solid waste configuration
  created_at: Timestamp; // When unit was created
}

// Legacy interface - kept for backward compatibility
interface TrashCan {
  service_type: string; // "Garbage" | "Recycle"
  size: number; // Size in gallons (e.g., 32, 64, 96)
}

// New structured solid waste configuration
interface SolidWasteDefaults {
  garbage_size: number; // 20, 32, 60, or 96 gallons
  compost_size: number; // 13 or 32 gallons (Food/Yard Waste)
  recycle_size: number; // 90 gallons typically
}
```

**Unit Naming Convention:**

- Unit names **MUST** follow the pattern "Unit XXX" where XXX is a number
- The number portion is used to match NextCentury meter readings
- Example: "Unit 401" matches NextCentury unit "401"
- Matching is done via regex: `/\d+/` extracts the number from the unit name

#### `users/` - App Users

Document ID is the user's email address (normalized to lowercase).

```typescript
interface AppUser {
  id: string; // User's email (normalized lowercase)
  email: string; // Email address
  role: UserRole; // "admin" | "member"
  name?: string; // Display name (optional)
  created_at: Timestamp; // When user was added
  added_by?: string; // Email of admin who added this user
}

type UserRole = "admin" | "member";
```

**Role Permissions:**

| Permission            | Admin | Member |
| --------------------- | ----- | ------ |
| View Dashboard        | ✅    | ✅     |
| View Bills            | ✅    | ✅     |
| Enter Readings        | ✅    | ✅     |
| Assign Adjustments    | ✅    | ✅     |
| Approve Bills         | ✅    | ✅     |
| Send Invoices         | ✅    | ✅     |
| Mark Paid             | ✅    | ✅     |
| View Units            | ✅    | ✅     |
| Add/Edit/Delete Units | ✅    | ❌     |
| View Settings         | ✅    | ❌     |
| Edit Credentials      | ✅    | ❌     |
| Connect Gmail         | ✅    | ❌     |
| Manage Users          | ✅    | ❌     |
| Run Scraper           | ✅    | ❌     |

#### `settings/` - Application Settings

Various configuration documents under the settings collection.

```typescript
// settings/utility_credentials
interface UtilityCredentials {
  seattle_utilities_username: string; // Login username
  seattle_utilities_password: string; // Login password
  seattle_utilities_account: string; // Account number (e.g., "4553370429")
  nextcentury_username: string; // Login email
  nextcentury_password: string; // Login password
  nextcentury_property_id: string; // Property ID (e.g., "p_25098")
  updated_at: Timestamp; // Last update time
}

// settings/gmail_token
interface GmailToken {
  email: string; // Connected Gmail address
  access_token: string; // OAuth access token
  refresh_token: string; // OAuth refresh token (for token renewal)
  scope: string; // Granted OAuth scopes
  expiry: Timestamp; // Access token expiry time
  updated_at: Timestamp; // Last update time
  authorized_by: string; // User ID who authorized
}

// settings/community
interface CommunitySettings {
  require_approval: boolean; // Manual approval before sending invoices
  reminder_days: number[]; // Days after invoice to send reminders (e.g., [7, 14])
  updated_at: Timestamp; // Last update time
}

// settings/scraper_status (updated during scraper runs)
interface ScraperStatus {
  status: "idle" | "running" | "completed" | "error";
  started_at?: Timestamp; // When scraper started
  completed_at?: Timestamp; // When scraper finished
  triggered_by?: string; // User ID who triggered (for manual runs)
  error?: string; // Error message if status is "error"
  result?: {
    new_bills?: number; // Number of new bills found
    total_checked?: number; // Total bills checked in billing history
  };
}

// settings/latest_readings (updated by NextCentury scraper)
interface LatestReadings {
  readings: Record<string, MeterReading>; // { "401": {...}, "406": {...} }
  fetched_at: Timestamp; // When readings were fetched
  unit: string; // "gallons" - primary unit
  period?: {
    start_date: string | null; // Period start if specified
    end_date: string | null; // Period end if specified
  };
}

// settings/meter_reading_status (updated during meter reading fetches)
interface MeterReadingStatus {
  status: "idle" | "running" | "completed" | "error";
  started_at?: Timestamp;
  completed_at?: Timestamp;
  error?: string;
  result?: {
    readings_count: number;
    bill_id?: string;
    period?: { start: string; end: string };
  };
}

// Individual meter reading from NextCentury (used in LatestReadings.readings)
interface MeterReading {
  gallons: number; // Primary measurement in gallons
  ccf: number; // Converted to CCF (gallons / 748)
  start_date: string; // Period start date
  end_date: string; // Period end date
}
```

---

## Web Application

### Firebase Initialization

[`web/src/firebase.ts`](web/src/firebase.ts) initializes the Firebase SDK:

```typescript
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getFunctions } from "firebase/functions";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: "utilitysplitter.firebaseapp.com",
  projectId: "utilitysplitter",
  storageBucket: "utilitysplitter.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);
export const storage = getStorage(app);
export const functions = getFunctions(app);

export default app;
```

**Exported Modules:**

- `auth` - Firebase Auth instance for authentication
- `googleProvider` - Google OAuth provider for sign-in
- `db` - Firestore instance for database operations
- `storage` - Cloud Storage instance for file uploads
- `functions` - Cloud Functions instance for callable functions

### Component Architecture

```
App.tsx (Root Component)
├── BrowserRouter
│   └── Routes
│       ├── /login → Login.tsx (unauthenticated only)
│       │
│       └── /* → ProtectedRoute wrapper
│           └── Layout.tsx (sidebar navigation)
│               ├── / → Dashboard.tsx
│               ├── /bills → Bills.tsx
│               ├── /bills/:billId → BillDetail.tsx
│               ├── /units → Units.tsx
│               ├── /units/:unitId/edit → UnitEdit.tsx
│               └── /settings → Settings.tsx
```

**App.tsx Implementation:**

```typescript
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <LoadingSpinner />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="bills" element={<Bills />} />
          <Route path="bills/:billId" element={<BillDetail />} />
          <Route path="units" element={<Units />} />
          <Route path="units/:unitId/edit" element={<UnitEdit />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
```

### Layout Component

[`web/src/components/Layout.tsx`](web/src/components/Layout.tsx) provides the main application shell:

```typescript
export function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();

  const navItems = [
    { path: "/", label: "Dashboard" },
    { path: "/bills", label: "Bills" },
    { path: "/units", label: "Units" },
    { path: "/settings", label: "Settings" },
  ];

  const isActive = (path: string) => {
    if (path === "/") return location.pathname === "/";
    return location.pathname.startsWith(path);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Desktop Navigation */}
      <nav className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex justify-between h-16">
            {/* Logo + Nav Links */}
            {/* User Menu + Logout */}
          </div>
        </div>
      </nav>

      {/* Mobile Navigation */}
      <div className="sm:hidden border-b bg-white">
        {/* Mobile nav links */}
      </div>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto py-6 px-4">
        <Outlet />
      </main>
    </div>
  );
}
```

### Custom Hooks

#### [`useAuth()`](web/src/hooks/useAuth.ts)

Manages Firebase Authentication state and Google Sign-In.

```typescript
export interface AuthState {
  user: User | null;
  loading: boolean;
  error: string | null;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(
      auth,
      (user) => setState({ user, loading: false, error: null }),
      (error) => setState({ user: null, loading: false, error: error.message })
    );
    return unsubscribe;
  }, []);

  const login = async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    await signInWithPopup(auth, googleProvider);
  };

  const logout = async () => {
    await signOut(auth);
  };

  return {
    user: state.user, // Firebase User object or null
    loading: state.loading, // True while checking auth state
    error: state.error, // Error message if any
    login, // Google Sign-In popup
    logout, // Sign out
    isAuthenticated: !!state.user, // Convenience boolean
  };
}
```

#### [`useBills()`](web/src/hooks/useBills.ts)

List-level hook for subscribing to bills collection.

```typescript
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

        // Sort by bill_date chronologically (MM/DD/YYYY string)
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
```

#### [`useBillDetail(billId)`](web/src/hooks/useBills.ts)

Detail-level hook for a single bill with subcollections.

```typescript
export function useBillDetail(billId: string) {
  const [bill, setBill] = useState<Bill | null>(null);
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!billId) return;

    // Subscribe to bill document
    const unsubBill = onSnapshot(doc(db, "bills", billId), ...);

    // Subscribe to subcollections
    const unsubAdj = onSnapshot(collection(db, "bills", billId, "adjustments"), ...);
    const unsubRead = onSnapshot(collection(db, "bills", billId, "readings"), ...);
    const unsubInv = onSnapshot(collection(db, "bills", billId, "invoices"), ...);

    return () => { unsubBill(); unsubAdj(); unsubRead(); unsubInv(); };
  }, [billId]);

  // Action methods
  const saveReading = async (unitId: string, submeter_id: string, reading: number) => {
    const readingRef = doc(db, "bills", billId, "readings", unitId);
    await setDoc(readingRef, {
      unit_id: unitId,
      submeter_id,
      reading,
      created_at: Timestamp.now(),
    }, { merge: true });
  };

  const assignAdjustment = async (adjId: string, unitIds: string[]) => {
    const adjRef = doc(db, "bills", billId, "adjustments", adjId);
    await updateDoc(adjRef, { assigned_unit_ids: unitIds });
  };

  const updateBillStatus = async (status: BillStatus) => {
    const billRef = doc(db, "bills", billId);
    const updateData: Record<string, unknown> = { status };
    if (status === "APPROVED") {
      updateData.approved_at = Timestamp.now();
    }
    await updateDoc(billRef, updateData);
  };

  const saveInvoice = async (invoice: Omit<Invoice, "id" | "status" | "sent_at" | "paid_at" | "reminders_sent">) => {
    const invoiceRef = doc(db, "bills", billId, "invoices", invoice.unit_id);
    await setDoc(invoiceRef, {
      ...invoice,
      status: "DRAFT",
      sent_at: null,
      paid_at: null,
      reminders_sent: 0,
    });
  };

  const markInvoicePaid = async (unitId: string) => {
    const invoiceRef = doc(db, "bills", billId, "invoices", unitId);
    await updateDoc(invoiceRef, {
      status: "PAID",
      paid_at: Timestamp.now(),
    });
  };

  // Fetch meter readings from NextCentury for bill period
  const fetchMeterReadings = useCallback(async (): Promise<Record<string, MeterReading> | null> => {
    if (!bill?.parsed_data?.services) {
      throw new Error("Bill has no parsed service data");
    }

    // Extract date range from water service
    const waterService = bill.parsed_data.services["Water"];
    if (!waterService?.parts?.length) {
      throw new Error("No water service data found in bill");
    }

    const firstPart = waterService.parts[0];
    const startDate = firstPart.start_date;
    const endDate = firstPart.end_date;

    if (!startDate || !endDate) {
      throw new Error(`No date range found in water service`);
    }

    const functions = getFunctions();
    const fetchReadings = httpsCallable<
      { startDate: string; endDate: string },
      { success: boolean; readings: Record<string, MeterReading>; unit: string; error?: string }
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

  // Get cached readings from Firestore settings
  const getLatestReadings = useCallback(async (): Promise<Record<string, MeterReading> | null> => {
    const readingsDoc = await getDoc(doc(db, "settings", "latest_readings"));
    if (readingsDoc.exists()) {
      return readingsDoc.data()?.readings || null;
    }
    return null;
  }, []);

  // Solid waste assignment functions
  const getSolidWasteAssignments = useCallback(async (): Promise<SolidWasteAssignment[]> => {
    const snapshot = await getDocs(collection(db, "bills", billId, "solid_waste_assignments"));
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) as SolidWasteAssignment[];
  }, [billId]);

  const saveSolidWasteAssignment = async (assignment: Omit<SolidWasteAssignment, "id" | "created_at">) => {
    const assignmentRef = doc(db, "bills", billId, "solid_waste_assignments", assignment.unit_id);
    await setDoc(assignmentRef, {
      ...assignment,
      created_at: Timestamp.now(),
    });
  };

  const deleteSolidWasteAssignment = async (unitId: string) => {
    await deleteDoc(doc(db, "bills", billId, "solid_waste_assignments", unitId));
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
    fetchMeterReadings,
    getLatestReadings,
    // Solid waste functions
    getSolidWasteAssignments,
    saveSolidWasteAssignment,
    deleteSolidWasteAssignment,
  };
}
```

#### [`useUnits()`](web/src/hooks/useUnits.ts)

CRUD operations for property units.

```typescript
export function useUnits() {
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onSnapshot(
      collection(db, "units"),
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
    await addDoc(collection(db, "units"), {
      ...unit,
      created_at: serverTimestamp(),
    });
  };

  const updateUnit = async (id: string, data: Partial<Unit>) => {
    await updateDoc(doc(db, "units", id), data);
  };

  const deleteUnit = async (id: string) => {
    await deleteDoc(doc(db, "units", id));
  };

  return { units, loading, error, addUnit, updateUnit, deleteUnit };
}
```

#### [`useUsers()` and `useCurrentUserRole()`](web/src/hooks/useUsers.ts)

User management and role checking.

```typescript
export function useUsers() {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onSnapshot(
      collection(db, "users"),
      (snapshot) => {
        const usersData = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as AppUser[];
        setUsers(usersData);
        setLoading(false);
      },
      (err) => {
        setError(err.message);
        setLoading(false);
      }
    );
    return unsubscribe;
  }, []);

  const addUser = async (email: string, role: UserRole, addedBy: string) => {
    const normalizedEmail = email.toLowerCase();
    const userRef = doc(db, "users", normalizedEmail);
    await setDoc(userRef, {
      email: normalizedEmail,
      role,
      added_by: addedBy,
      created_at: serverTimestamp(),
    });
  };

  const updateUserRole = async (userEmail: string, role: UserRole) => {
    await setDoc(doc(db, "users", userEmail), { role }, { merge: true });
  };

  const removeUser = async (userEmail: string) => {
    await deleteDoc(doc(db, "users", userEmail));
  };

  const bootstrapAdmin = async (email: string) => {
    const normalizedEmail = email.toLowerCase();
    const userRef = doc(db, "users", normalizedEmail);
    await setDoc(userRef, {
      email: normalizedEmail,
      role: "admin" as UserRole,
      added_by: "bootstrap",
      created_at: serverTimestamp(),
    });
  };

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

export function useCurrentUserRole(email: string | null | undefined) {
  const [role, setRole] = useState<UserRole | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!email) {
      setRole(null);
      setLoading(false);
      return;
    }

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
      },
      (err) => {
        console.error("Error getting user role:", err);
        setRole(null);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [email]);

  return { role, loading, isAdmin: role === "admin" };
}
```

### Page Components

#### [`Login.tsx`](web/src/pages/Login.tsx)

Simple login page with Google Sign-In button.

**Features:**

- Shows loading spinner while checking auth
- Redirects to Dashboard if already authenticated
- Displays error messages on auth failure

#### [`Dashboard.tsx`](web/src/pages/Dashboard.tsx)

Overview page showing bill summary statistics.

**Features:**

- Count of bills by status
- Quick links to pending bills
- Recent activity summary

#### [`Bills.tsx`](web/src/pages/Bills.tsx)

Lists all bills with filtering and status badges.

**Features:**

- Status filtering (NEW, NEEDS_REVIEW, etc.)
- Click to navigate to BillDetail
- Shows bill date, total amount, status

#### [`BillDetail.tsx`](web/src/pages/BillDetail.tsx)

Comprehensive bill detail page with all workflow features.

**Sections:**

1. **Bill Summary**: Date, due date, total, status badge, PDF link
2. **Meter Readings**: Input fields for each unit's submeter reading
   - Status box showing fetch state (idle/running/completed/error)
   - "Refresh from Meters" button to fetch from NextCentury
   - Auto-populates readings for units without saved values
   - Shows both gallons and CCF conversion
3. **Solid Waste Assignment**: Assign garbage, recycling, and compost items to units
   - Displays all solid waste items from bill (grouped by type)
   - Dropdown for each item to select which unit pays for it
   - Auto-fills from unit solid waste defaults on initial load
   - Validation ensures each unit has exactly one garbage, one recycling, one compost
   - Shows totals per unit for verification
4. **Adjustments** (if any): Checkboxes to assign adjustments to units
5. **Invoice Preview**: Calculated invoices with line items grouped by category
   - Color-coded by category (water, sewer, drainage, solid waste, adjustments)
   - Shows unit totals with running sum validation
   - **Total Match Indicator**: Shows if sum of unit invoices equals bill total
6. **Actions**: Status transition buttons (Mark Ready, Approve & Send)
   - "Mark Ready for Approval" button disabled if validation fails
   - Validation errors displayed with specific missing items

**Solid Waste Auto-Fill Logic:**

When BillDetail loads, it auto-fills solid waste assignments from unit defaults:

```typescript
// On initial load, match bill items to unit defaults by size
const autoFillSolidWaste = useCallback(() => {
  const billItems = extractSolidWasteItems(bill.parsed_data);
  
  // For each unit, find matching items by size from their defaults
  units.forEach(unit => {
    const defaults = unit.solidWasteDefaults;
    if (!defaults) return;
    
    // Find unassigned garbage item matching unit's default size
    const garbageItem = billItems.garbage.find(
      item => item.size === defaults.garbage_size && !item.assignedUnitId
    );
    if (garbageItem) garbageItem.assignedUnitId = unit.id;
    
    // Same for recycling and compost...
  });
}, [bill, units]);
```

**Bill Readiness Validation:**

```typescript
interface BillReadinessResult {
  isReady: boolean;
  errors: string[];
  details: {
    readingsComplete: boolean;
    solidWasteComplete: boolean;
    adjustmentsComplete: boolean;
    totalsMatch: boolean;
    invoiceSum: number;
    billTotal: number;
  };
}

// Validation happens before allowing "Approve & Send"
const validateBillReadiness = (): BillReadinessResult => {
  const errors: string[] = [];
  
  // 1. Check all units have readings
  const readingsComplete = units.every(u =>
    readings.some(r => r.unit_id === u.id && r.reading > 0)
  );
  if (!readingsComplete) errors.push("Some units are missing water readings");
  
  // 2. Check all solid waste items assigned
  const swItems = extractSolidWasteItems(bill.parsed_data);
  const allGarbageAssigned = swItems.garbage.every(i => i.assignedUnitId);
  const allRecycleAssigned = swItems.recycle.every(i => i.assignedUnitId);
  const allCompostAssigned = swItems.compost.every(i => i.assignedUnitId);
  const solidWasteComplete = allGarbageAssigned && allRecycleAssigned && allCompostAssigned;
  if (!solidWasteComplete) errors.push("Some solid waste items not assigned to units");
  
  // 3. Check all adjustments assigned
  const adjustmentsComplete = adjustments.every(a => a.assigned_unit_ids.length > 0);
  if (!adjustmentsComplete) errors.push("Some adjustments not assigned to units");
  
  // 4. Check invoice totals match bill total
  const { totalMatches, invoiceSum } = calculateInvoices(...);
  if (!totalsMatch) {
    errors.push(`Invoice sum ($${invoiceSum.toFixed(2)}) doesn't match bill ($${bill.total_amount.toFixed(2)})`);
  }
  
  return {
    isReady: errors.length === 0,
    errors,
    details: { readingsComplete, solidWasteComplete, adjustmentsComplete, totalsMatch, invoiceSum, billTotal }
  };
};
```

**Meter Reading Status Display:**

```typescript
interface MeterReadingStatus {
  status: "idle" | "running" | "completed" | "error";
  started_at?: Timestamp;
  completed_at?: Timestamp;
  error?: string;
  result?: {
    readings_count: number;
    bill_id?: string;
  };
}
```

**Auto-Fetch Behavior:**

- When bill loads with status NEW or NEEDS_REVIEW, auto-fetches readings
- Waits for Firestore data to load before deciding to auto-fetch
- Only auto-fetches if not all units have saved readings yet
- Auto-fetch passes `forceOverwrite=false` to preserve existing saved readings
- Manual "Refresh from Meters" button passes `forceOverwrite=true` to overwrite all
- Matches unit names to readings by extracting number (e.g., "Unit 401" → "401")

**handleFetchReadings Implementation:**

```typescript
// @param forceOverwrite - if true, overwrite existing saved readings (manual refresh)
//                         if false, only populate units without saved readings (auto-fetch)
const handleFetchReadings = useCallback(
  async (forceOverwrite = false) => {
    if (fetchingReadings) return;

    setFetchingReadings(true);
    setMeterReadingStatus({ status: "running", started_at: Timestamp.now() });

    try {
      // Always fetch fresh readings from NextCentury API for this bill's date range
      const result = await fetchMeterReadings();

      if (result && Object.keys(result).length > 0) {
        setMeterReadings(result);

        // Pre-populate local readings with fetched meter values
        // Only populate for units that don't have saved readings (unless forceOverwrite is true)
        const newLocalReadings: Record<string, string> = {};
        for (const unit of units) {
          // Check if unit already has a saved reading in Firestore
          const existingSavedReading = readings.find(
            (r) => r.unit_id === unit.id
          );

          // Skip units with saved readings unless this is a manual refresh
          if (existingSavedReading && !forceOverwrite) {
            continue;
          }

          // Try to match unit name to meter reading (e.g., "Unit 401" -> "401")
          const unitNumber = unit.name.replace(/[^0-9]/g, "");
          const meterReading = result[unitNumber];

          if (meterReading) {
            newLocalReadings[unit.id] = meterReading.gallons.toString();
          }
        }

        if (Object.keys(newLocalReadings).length > 0) {
          setLocalReadings((prev) => ({ ...prev, ...newLocalReadings }));
        }

        setMeterReadingStatus({
          status: "completed",
          completed_at: Timestamp.now(),
          result: { readings_count: Object.keys(result).length },
        });
      } else {
        setMeterReadingStatus({
          status: "error",
          error: "No readings returned. Check NextCentury credentials.",
        });
      }
    } catch (err) {
      setMeterReadingStatus({
        status: "error",
        error: err instanceof Error ? err.message : "Failed to fetch readings",
      });
    } finally {
      setFetchingReadings(false);
    }
  },
  [fetchMeterReadings, units, readings, fetchingReadings, billId]
);

// Auto-fetch effect waits for Firestore data to load
useEffect(() => {
  if (
    bill &&
    units.length > 0 &&
    !autoFetchAttempted &&
    !loading && // Wait for Firestore data to load
    (bill.status === "NEW" || bill.status === "NEEDS_REVIEW")
  ) {
    setAutoFetchAttempted(true);

    // Check if bill already has saved readings for all units
    if (readings.length >= units.length) {
      setMeterReadingStatus({
        status: "completed",
        result: { readings_count: readings.length },
      });
      return;
    }

    // Fetch readings but don't overwrite any existing saved readings
    handleFetchReadings(false);
  }
}, [bill, units, autoFetchAttempted, readings.length, loading, handleFetchReadings]);

// Manual refresh button calls with forceOverwrite=true
<button onClick={() => handleFetchReadings(true)}>Refresh from Meters</button>
```

#### [`Units.tsx`](web/src/pages/Units.tsx)

Lists all units with creation form.

**Features:**

- Unit list with name, sqft, submeter ID, email
- Add new unit form
- Edit/delete links
- Trash can management

#### [`UnitEdit.tsx`](web/src/pages/UnitEdit.tsx)

Edit form for a single unit.

**Features:**

- Edit name, sqft, submeter ID, email
- Configure solid waste defaults (garbage, recycling, compost sizes)
- Size options: Garbage (20/32/60/96 gal), Compost (13/32 gal), Recycle (90 gal)
- Delete unit option

**Solid Waste Defaults UI:**

```typescript
// Size options for each solid waste type
const GARBAGE_SIZES = [20, 32, 60, 96];   // gallons
const COMPOST_SIZES = [13, 32];           // gallons (Food/Yard Waste)
const RECYCLE_SIZES = [90];                // gallons

// Form state
const [solidWasteDefaults, setSolidWasteDefaults] = useState<SolidWasteDefaults>({
  garbage_size: 32,
  compost_size: 13,
  recycle_size: 90,
});
```

#### [`Settings.tsx`](web/src/pages/Settings.tsx)

Configuration page for admins.

**Sections:**

1. **Utility Credentials**: Seattle Utilities and NextCentury login info
   - Account number, username, password fields
   - Show/hide password toggle
2. **Gmail Configuration**: OAuth connection for sending invoices
   - Connect/Disconnect buttons
   - Status display showing connected email
3. **Bill Processing Settings**: Approval requirements, reminder days
4. **Manual Scraper Trigger**: Run scraper on demand with status display
5. **User Management**: Add/remove users, change roles
   - Bootstrap admin initialization
   - User list with role dropdowns

### Invoice Calculator

[`web/src/services/invoiceCalculator.ts`](web/src/services/invoiceCalculator.ts)

Calculates per-unit invoices from bill data with fair rounding using Hamilton's method.

```typescript
// Line item categories for grouping in UI
export type LineItemCategory =
  | "water_usage"    // Water by meter reading ratio
  | "water_sqft"     // Water by square footage (common area)
  | "sewer"          // Sewer charges
  | "drainage"       // Drainage charges
  | "solid_waste"    // Garbage, recycling, food/yard waste
  | "adjustment";    // Bill adjustments (credits/debits)

export interface LineItem {
  description: string;
  amount: number;
  category: LineItemCategory;
}

export interface CalculatedInvoice {
  unit_id: string;
  unit_name: string;
  tenant_email: string;
  amount: number;
  line_items: LineItem[];
}

export interface InvoiceValidation {
  isValid: boolean;
  invoiceTotal: number;
  billTotal: number;
  difference: number;
  errors: string[];
}

/**
 * Calculate invoices for all units based on bill data, readings, adjustments,
 * and solid waste assignments. Uses Hamilton's method for fair rounding.
 */
export function calculateInvoices(
  bill: Bill,
  units: Unit[],
  readings: Reading[],
  adjustments: Adjustment[],
  solidWasteAssignments: SolidWasteAssignment[]
): CalculatedInvoice[] {
  // ... calculation logic with fair rounding
}

/**
 * Validate that invoice totals match bill total.
 * Returns validation result with any errors.
 */
export function validateInvoiceTotals(
  invoices: CalculatedInvoice[],
  billTotal: number
): InvoiceValidation {
  const invoiceTotal = invoices.reduce((sum, inv) => sum + inv.amount, 0);
  const difference = Math.abs(invoiceTotal - billTotal);
  const isValid = difference < 0.01; // Allow 1 cent tolerance
  
  const errors: string[] = [];
  if (!isValid) {
    errors.push(`Invoice total ($${invoiceTotal.toFixed(2)}) doesn't match bill total ($${billTotal.toFixed(2)})`);
  }
  
  return { isValid, invoiceTotal, billTotal, difference, errors };
}
```

#### Hamilton's Method (Fair Rounding)

When splitting costs between units, simple rounding can cause discrepancies. For example, splitting $76.81 between 2 units:
- Simple: $38.405 → $38.41 each = $76.82 total (1 cent off!)
- Hamilton's: [$38.41, $38.40] = $76.81 exactly ✓

The invoice calculator uses **Hamilton's method** (also called "largest remainder method") to distribute cents fairly:

```typescript
/**
 * Rounds an array of amounts to the target total using Hamilton's method.
 * Only applies fair distribution if unrounded sum matches target exactly.
 *
 * @param unroundedAmounts - Array of precise amounts (e.g., [38.405, 38.405])
 * @param targetTotal - The exact total these should sum to (e.g., 76.81)
 * @returns Rounded amounts that sum exactly to targetTotal (e.g., [38.41, 38.40])
 */
function roundToTotal(unroundedAmounts: number[], targetTotal: number): number[] {
  // Check if unrounded sum matches target (indicates all items assigned)
  const unroundedSum = unroundedAmounts.reduce((sum, a) => sum + a, 0);
  const isExactMatch = Math.abs(unroundedSum - targetTotal) < 0.001;
  
  if (!isExactMatch) {
    // Mismatch indicates unassigned items - use simple rounding
    // This preserves the error signal for validation
    return unroundedAmounts.map(a => round(a));
  }
  
  // Hamilton's method: floor all, then distribute remainders to largest
  const floored = unroundedAmounts.map(a => Math.floor(a * 100));
  const remainders = unroundedAmounts.map((a, i) => ({
    index: i,
    remainder: (a * 100) - floored[i]
  }));
  
  const totalFloored = floored.reduce((sum, f) => sum + f, 0);
  const centsToDistribute = Math.round(targetTotal * 100) - totalFloored;
  
  // Sort by remainder descending, give extra cent to largest remainders
  remainders.sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < centsToDistribute; i++) {
    floored[remainders[i].index] += 1;
  }
  
  return floored.map(f => f / 100);
}

/**
 * Distribute amount evenly using Hamilton's method.
 * Example: distributeEvenly(100, 3) → [33.34, 33.33, 33.33]
 */
function distributeEvenly(total: number, count: number): number[] {
  if (count === 0) return [];
  const share = total / count;
  return roundToTotal(Array(count).fill(share), total);
}

/**
 * Distribute amount by weights using Hamilton's method.
 * Example: distributeByWeight(100, [1, 2, 3]) → [16.67, 33.33, 50.00]
 */
function distributeByWeight(total: number, weights: number[]): number[] {
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight === 0) return weights.map(() => 0);
  const shares = weights.map(w => (w / totalWeight) * total);
  return roundToTotal(shares, total);
}
```

**Why Hamilton's Method?**

| Scenario | Simple Rounding | Hamilton's Method |
|----------|-----------------|-------------------|
| $76.81 ÷ 2 | [$38.41, $38.41] = $76.82 ❌ | [$38.41, $38.40] = $76.81 ✓ |
| $100 ÷ 3 | [$33.33, $33.33, $33.33] = $99.99 ❌ | [$33.34, $33.33, $33.33] = $100.00 ✓ |
| $10 ÷ 6 | [$1.67, $1.67, ...] = $10.02 ❌ | [$1.67, $1.67, $1.67, $1.67, $1.66, $1.66] = $10.00 ✓ |

#### Line Item Categories

Line items are categorized for grouped display in the invoice preview:

| Category | Description | Color (UI) |
|----------|-------------|------------|
| `water_usage` | Water by meter reading | Blue |
| `water_sqft` | Common area water (by sqft) | Light Blue |
| `sewer` | Sewer charges | Purple |
| `drainage` | Drainage charges | Teal |
| `solid_waste` | Garbage, recycling, compost | Green |
| `adjustment` | Credits and debits | Orange |

#### Calculation Logic

1. **Water/Sewer Charges (Proportional by Usage)**:
   ```
   Unit's Water Cost = (Unit's Gallons / Total Submeter Gallons) × (Water Total - Common Area Water)
   Unit's Sewer Cost = (Unit's Gallons / Total Submeter Gallons) × (Sewer Total - Common Area Sewer)
   ```

2. **Common Area Charges (Proportional by Square Footage)**:
   ```
   Common Area Usage = Master Meter CCF - Sum(Submeter Gallons) / 748
   Common Area Cost = Common Area Ratio × Service Total
   Unit's Common Area Cost = (Unit's SqFt / Total SqFt) × Common Area Cost
   ```

3. **Drainage (Split Evenly)**:
   ```
   Unit's Drainage = Drainage Total / Number of Units
   ```

4. **Solid Waste (Direct Assignment)**:
   ```
   Unit's Solid Waste = Sum of assigned garbage + recycling + compost items
   ```

5. **Adjustments (Split Among Assigned Units)**:
   ```
   Unit's Adjustment = Adjustment Cost / Number of Assigned Units
   ```

#### Bill Readiness Validation

A bill is considered **ready for approval** only when:

1. **All meter readings entered** - Each unit has a water meter reading
2. **All solid waste items assigned** - Every garbage, recycling, and compost item is assigned to exactly one unit
3. **All adjustments assigned** - Every adjustment is assigned to at least one unit
4. **Invoice totals match bill total** - Sum of all unit invoice amounts equals the bill total (within 1 cent)

```typescript
// Validation checks performed before allowing "Approve & Send"
interface BillReadinessCheck {
  readingsComplete: boolean;      // All units have readings
  solidWasteComplete: boolean;    // All solid waste items assigned
  adjustmentsComplete: boolean;   // All adjustments assigned
  totalsMatch: boolean;           // Invoice sum = bill total
  isReady: boolean;               // All checks pass
  errors: string[];               // Human-readable error messages
}
```

---

## Cloud Functions

All Cloud Functions are defined in [`functions/src/index.ts`](functions/src/index.ts).

### Gmail OAuth Functions

#### `getGmailAuthUrl` (HTTPS Callable)

Generates Google OAuth authorization URL for Gmail.

```typescript
// Request: none
// Response: { authUrl: string }

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
];

export const getGmailAuthUrl = functions.https.onCall(
  async (_data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Must be authenticated"
      );
    }

    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      `https://us-central1-utilitysplitter.cloudfunctions.net/gmailOAuthCallback`
    );

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: GMAIL_SCOPES,
      prompt: "consent", // Always get refresh token
      state: context.auth.uid,
    });

    return { authUrl };
  }
);
```

#### `gmailOAuthCallback` (HTTP GET)

Handles OAuth callback from Google after user authorization.

```typescript
// GET /gmailOAuthCallback?code=xxx&state=userId&error=xxx
// Redirects to: /settings?gmail_success=true&email=xxx
//          or: /settings?gmail_error=xxx

export const gmailOAuthCallback = functions.https.onRequest(
  async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
      res.redirect(
        `https://utilitysplitter.web.app/settings?gmail_error=${encodeURIComponent(
          String(error)
        )}`
      );
      return;
    }

    if (!code || typeof code !== "string") {
      res.redirect(
        "https://utilitysplitter.web.app/settings?gmail_error=no_code"
      );
      return;
    }

    try {
      const oauth2Client = getOAuth2Client();
      const { tokens } = await oauth2Client.getToken(code);

      if (!tokens.refresh_token) {
        res.redirect(
          "https://utilitysplitter.web.app/settings?gmail_error=no_refresh_token"
        );
        return;
      }

      // Get user's email
      oauth2Client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
      const userInfo = await oauth2.userinfo.get();
      const email = userInfo.data.email;

      // Store tokens in Firestore
      await db
        .collection("settings")
        .doc("gmail_token")
        .set({
          email,
          access_token: tokens.access_token || "",
          refresh_token: tokens.refresh_token,
          scope: tokens.scope || GMAIL_SCOPES.join(" "),
          expiry: tokens.expiry_date
            ? admin.firestore.Timestamp.fromMillis(tokens.expiry_date)
            : admin.firestore.Timestamp.fromMillis(Date.now() + 3600000),
          updated_at: admin.firestore.Timestamp.now(),
          authorized_by: state || "unknown",
        });

      res.redirect(
        `https://utilitysplitter.web.app/settings?gmail_success=true&email=${encodeURIComponent(
          email
        )}`
      );
    } catch (err) {
      res.redirect(
        `https://utilitysplitter.web.app/settings?gmail_error=${encodeURIComponent(
          String(err)
        )}`
      );
    }
  }
);
```

#### `disconnectGmail` (HTTPS Callable)

Removes Gmail OAuth tokens.

```typescript
// Request: none
// Response: { success: boolean }

export const disconnectGmail = functions.https.onCall(
  async (_data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Must be authenticated"
      );
    }

    await db.collection("settings").doc("gmail_token").delete();
    return { success: true };
  }
);
```

### Email Functions

#### `sendInvoiceEmail` (HTTPS Callable)

Sends a single invoice email.

```typescript
// Request: { billId: string, invoiceId: string }
// Response: { success: boolean }

export const sendInvoiceEmail = functions.https.onCall(
  async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Must be authenticated"
      );
    }

    const { billId, invoiceId } = data;

    // Get bill and invoice data
    const billDoc = await db.collection("bills").doc(billId).get();
    const invoiceDoc = await db
      .collection("bills")
      .doc(billId)
      .collection("invoices")
      .doc(invoiceId)
      .get();

    // Get Gmail transporter
    const transporter = await getGmailTransporter();

    // Send email
    const html = generateInvoiceHtml(invoice, bill.bill_date);
    await transporter.sendMail({
      to: invoice.tenant_email,
      subject: `Utility Invoice - ${bill.bill_date}`,
      html,
    });

    // Update invoice status
    await invoiceDoc.ref.update({
      status: "SENT",
      sent_at: admin.firestore.Timestamp.now(),
    });

    return { success: true };
  }
);
```

**Email Template (generateInvoiceHtml):**

```typescript
function generateInvoiceHtml(invoice: Invoice, billDate: string): string {
  const lineItemsHtml = invoice.line_items
    .map(
      (item) =>
        `<tr><td>${item.description}</td><td>$${item.amount.toFixed(
          2
        )}</td></tr>`
    )
    .join("");

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; }
        .header { background: #2563eb; color: white; padding: 20px; }
        .content { padding: 20px; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }
        .total { font-size: 1.2em; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Utility Invoice</h1>
      </div>
      <div class="content">
        <p>Hello ${invoice.unit_name},</p>
        <p>Here is your utility invoice for the billing period ending ${billDate}:</p>

        <table>
          <tr><th>Description</th><th>Amount</th></tr>
          ${lineItemsHtml}
          <tr class="total"><td>Total</td><td>$${invoice.amount.toFixed(
            2
          )}</td></tr>
        </table>

        <p>Please submit payment at your earliest convenience.</p>
        <p>Thank you!</p>
      </div>
    </body>
    </html>
  `;
}
```

#### `sendAllInvoices` (HTTPS Callable)

Sends all draft invoices for a bill.

```typescript
// Request: { billId: string }
// Response: { success: boolean, results: Array<{ id: string, success: boolean, error?: string }> }

export const sendAllInvoices = functions.https.onCall(async (data, context) => {
  const { billId } = data;

  const invoicesSnapshot = await db.collection("bills").doc(billId)
    .collection("invoices")
    .where("status", "==", "DRAFT")
    .get();

  const transporter = await getGmailTransporter();
  const results = [];

  for (const invoiceDoc of invoicesSnapshot.docs) {
    try {
      await transporter.sendMail({ ... });
      await invoiceDoc.ref.update({ status: "SENT", sent_at: admin.firestore.Timestamp.now() });
      results.push({ id: invoiceDoc.id, success: true });
    } catch (error) {
      results.push({ id: invoiceDoc.id, success: false, error: String(error) });
    }
  }

  // Update bill status
  await db.collection("bills").doc(billId).update({
    status: "INVOICED",
    approved_at: admin.firestore.Timestamp.now(),
    approved_by: context.auth.uid,
  });

  return { success: true, results };
});
```

### Scheduled Functions

#### `sendReminders` (Pub/Sub Schedule)

Sends payment reminders for overdue invoices.

```typescript
// Schedule: "0 9 * * *" (daily at 9 AM Pacific)
// Timezone: America/Los_Angeles

export const sendReminders = functions.pubsub
  .schedule("0 9 * * *")
  .timeZone("America/Los_Angeles")
  .onRun(async () => {
    // Get reminder_days from settings (e.g., [7, 14])
    const settingsDoc = await db.collection("settings").doc("community").get();
    const reminderDays: number[] = settingsDoc.data()?.reminder_days || [7, 14];

    // Get all INVOICED bills
    const billsSnapshot = await db.collection("bills")
      .where("status", "==", "INVOICED")
      .get();

    const transporter = await getGmailTransporter();

    for (const billDoc of billsSnapshot.docs) {
      const invoicesSnapshot = await billDoc.ref.collection("invoices")
        .where("status", "==", "SENT")
        .get();

      for (const invoiceDoc of invoicesSnapshot.docs) {
        const invoice = invoiceDoc.data() as Invoice;
        if (!invoice.sent_at) continue;

        const daysSinceSent = Math.floor(
          (Date.now() - invoice.sent_at.toDate().getTime()) / (1000 * 60 * 60 * 24)
        );

        for (let i = 0; i < reminderDays.length; i++) {
          if (daysSinceSent === reminderDays[i] && invoice.reminders_sent <= i) {
            // Send reminder
            await transporter.sendMail({ ... });
            await invoiceDoc.ref.update({ reminders_sent: invoice.reminders_sent + 1 });
            break;
          }
        }
      }
    }

    return null;
  });
```

#### `triggerScraper` (Pub/Sub Schedule)

Automatically triggers the scraper service.

```typescript
// Schedule: "0 6 */3 * *" (every 3 days at 6 AM Pacific)
// Timezone: America/Los_Angeles

export const triggerScraper = functions.pubsub
  .schedule("0 6 */3 * *")
  .timeZone("America/Los_Angeles")
  .onRun(async () => {
    const scraperUrl = process.env.SCRAPER_URL;

    const response = await fetch(scraperUrl + "/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "all" }),
    });

    const result = await response.json();
    console.log("Scraper result:", result);

    return null;
  });
```

### Meter Readings Function

#### `fetchMeterReadings` (HTTPS Callable)

Fetches meter readings from NextCentury for a specific date range.

```typescript
// Timeout: 120 seconds
// Memory: 256MB
// Request: { startDate: string, endDate: string }
// Response: { success: boolean, readings: Record<string, MeterReading>, unit: "gallons" }

export const fetchMeterReadings = functions
  .runWith({ timeoutSeconds: 120, memory: "256MB" })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Must be authenticated"
      );
    }

    const { startDate, endDate } = data;
    if (!startDate || !endDate) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "startDate and endDate required"
      );
    }

    const scraperUrl = process.env.SCRAPER_URL;

    const response = await fetch(scraperUrl + "/readings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start_date: startDate, end_date: endDate }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Scraper returned ${response.status}: ${errorText}`);
    }

    const result = await response.json();

    return {
      success: true,
      readings: result.readings,
      unit: result.unit || "gallons",
    };
  });
```

### Manual Trigger Function

#### `triggerScraperManual` (HTTPS Callable)

Manually triggers the scraper with status updates.

```typescript
// Timeout: 540 seconds (9 minutes max)
// Memory: 256MB
// Request: { type?: "seattle_utilities" | "nextcentury_meters" | "all" }
// Response: ScraperResult

export const triggerScraperManual = functions
  .runWith({ timeoutSeconds: 540, memory: "256MB" })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Must be authenticated"
      );
    }

    const scraperUrl = process.env.SCRAPER_URL;

    // Update status to running
    await db.collection("settings").doc("scraper_status").set({
      status: "running",
      started_at: admin.firestore.Timestamp.now(),
      triggered_by: context.auth.uid,
    });

    try {
      const response = await fetch(scraperUrl + "/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: data.type || "all" }),
      });

      const result = await response.json();

      // Update status to completed
      await db
        .collection("settings")
        .doc("scraper_status")
        .set({
          status: "completed",
          started_at: admin.firestore.Timestamp.now(),
          completed_at: admin.firestore.Timestamp.now(),
          result: {
            new_bills: result.seattle_utilities?.new_bills?.length || 0,
            total_checked: result.seattle_utilities?.total_checked || 0,
          },
        });

      return result;
    } catch (error) {
      // Update status to error
      await db
        .collection("settings")
        .doc("scraper_status")
        .set({
          status: "error",
          started_at: admin.firestore.Timestamp.now(),
          completed_at: admin.firestore.Timestamp.now(),
          error: error instanceof Error ? error.message : String(error),
        });

      throw new functions.https.HttpsError(
        "internal",
        "Failed to trigger scraper"
      );
    }
  });
```

---

## Scraper Service

The scraper service is a Flask application running on Cloud Run. It uses Playwright for browser automation.

### Dockerfile Configuration

[`scraper/Dockerfile`](scraper/Dockerfile):

```dockerfile
FROM python:3.13-slim

# Install system dependencies for Playwright
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install uv for faster dependency management
RUN pip install uv

# Copy dependency files first (for caching)
COPY pyproject.toml uv.lock ./

# Create fresh venv and install dependencies
RUN uv venv && uv sync --no-dev --frozen

# Install Playwright browsers
RUN uv run playwright install chromium

# Copy application code
COPY main.py parser.py ./
COPY scrapers ./scrapers/

# Cloud Run uses PORT env var
ENV PORT=8080
EXPOSE 8080

CMD ["uv", "run", "gunicorn", "-b", "0.0.0.0:8080", "--timeout", "300", "main:app"]
```

### Main Application ([`scraper/main.py`](scraper/main.py))

```python
"""
Cloud Run Scraper Service

Handles all Playwright-based scraping for:
- Seattle Utilities (bills)
- NextCentury Meters (readings)

Triggered by Cloud Scheduler or manual trigger, writes results to Firestore.
"""

import logging
import os

from firebase_admin import credentials, firestore, initialize_app, storage
from flask import Flask, jsonify, request

# Initialize Firebase
cred = credentials.ApplicationDefault()
initialize_app(
    cred,
    {"storageBucket": f"{os.environ.get('GCP_PROJECT_ID', 'utilitysplitter')}.firebasestorage.app"}
)
db = firestore.client()
bucket = storage.bucket()

from parser import BillParser
from scrapers.nextcentury_meters import NextCenturyMetersScraper
from scrapers.seattle_utilities import SeattleUtilitiesScraper

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)
```

### Endpoints

#### `GET /health`

Health check endpoint for Cloud Run.

```python
@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint."""
    return jsonify({"status": "healthy"})
```

#### `POST /readings`

Fetch meter readings for a specific date range.

**Request:**

```json
{
  "start_date": "Dec 01, 2024", // or "12/01/2024" or "2024-12-01"
  "end_date": "Dec 31, 2024"
}
```

**Response:**

```json
{
  "success": true,
  "readings": {
    "401": {
      "gallons": 1788,
      "ccf": 2.39,
      "start_date": "2024-12-01",
      "end_date": "2024-12-31"
    },
    "406": {
      "gallons": 2700,
      "ccf": 3.61,
      "start_date": "2024-12-01",
      "end_date": "2024-12-31"
    }
  },
  "unit": "gallons"
}
```

**Implementation:**

```python
@app.route("/readings", methods=["POST"])
def get_readings():
    """Fetch meter readings for a specific date range."""
    try:
        data = request.get_json() or {}
        start_date = data.get("start_date")
        end_date = data.get("end_date")

        # Get credentials from Firestore
        creds = get_utility_credentials()
        if not creds:
            return jsonify({"success": False, "error": "Missing credentials"}), 400

        username = creds.get("nextcentury_username")
        password = creds.get("nextcentury_password")
        property_id = creds.get("nextcentury_property_id")

        if not username or not password or not property_id:
            return jsonify({"success": False, "error": "Missing NextCentury credentials"}), 400

        scraper = NextCenturyMetersScraper(username, password, property_id)

        try:
            if start_date and end_date:
                readings = scraper.get_readings_for_bill_period(start_date, end_date)
            else:
                readings = scraper.get_current_readings(60)

            # Store readings in Firestore
            if readings:
                db.collection("settings").document("latest_readings").set({
                    "readings": readings,
                    "fetched_at": firestore.SERVER_TIMESTAMP,
                    "period": {"start_date": start_date, "end_date": end_date} if start_date else None,
                })

            return jsonify({"success": True, "readings": readings, "unit": "gallons"})
        finally:
            scraper.close()

    except Exception as e:
        log.error(f"Error fetching readings: {e}", exc_info=True)
        return jsonify({"success": False, "error": str(e)}), 500
```

#### `POST /scrape`

Main scraping endpoint for bills and/or meter readings.

**Request:**

```json
{
  "type": "seattle_utilities" | "nextcentury_meters" | "all",
  "community_id": "optional"
}
```

**Response:**

```json
{
  "success": true,
  "seattle_utilities": {
    "new_bills": [
      {
        "id": "abc123",
        "date": "12/01/2024",
        "amount": 425.67,
        "readings_populated": 6
      }
    ],
    "total_checked": 12
  },
  "nextcentury_meters": {
    "readings": {"401": {...}},
    "unit": "gallons"
  }
}
```

### Seattle Utilities Scraper

[`scraper/scrapers/seattle_utilities.py`](scraper/scrapers/seattle_utilities.py)

**Class: SeattleUtilitiesScraper**

```python
class SeattleUtilitiesScraper:
    """
    Scrapes bills from Seattle Utilities website using Playwright.

    Usage:
        scraper = SeattleUtilitiesScraper(username, password, account)
        try:
            bills = scraper.check_for_new_bills()
            for bill in bills:
                pdf_path = scraper.download_bill(bill['date'])
        finally:
            scraper.close()
    """

    BASE_URL = "https://myutilities.seattle.gov"
    LOGIN_URL = f"{BASE_URL}/rest/auth/ssologin"

    def __init__(self, username: str, password: str, account: str):
        """Initialize with login credentials and account number."""
        self.username = username
        self.password = password
        self.account = account
        self._playwright = None
        self._browser: Optional[Browser] = None
        self._context: Optional[BrowserContext] = None
        self._page: Optional[Page] = None
        self._logged_in = False

    def _ensure_browser(self):
        """Ensure browser is initialized."""
        if self._browser is None:
            self._playwright = sync_playwright().start()
            self._browser = self._playwright.chromium.launch(headless=True)
            self._context = self._browser.new_context()
            self._page = self._context.new_page()

    def _login(self):
        """Log into Seattle Utilities website."""
        if self._logged_in:
            return

        self._ensure_browser()
        self._page.goto(self.LOGIN_URL)
        self._page.wait_for_selector('input[name="userName"]', timeout=30000)

        self._page.locator('input[name="userName"]').fill(self.username)
        self._page.locator('input[name="password"]').fill(self.password)
        self._page.locator('button[type="submit"]').click()

        self._page.wait_for_url("**/eportal/**", timeout=60000)
        self._page.wait_for_load_state("networkidle", timeout=30000)
        self._logged_in = True

    def check_for_new_bills(self) -> list[dict]:
        """
        Check billing history for available bills.
        Returns: [{"date": "12/01/2024", "amount": 425.67}, ...]
        """
        self._navigate_to_billing_history()

        all_rows = self._page.locator("table.app-table tbody tr").all()
        bills = []

        for row in all_rows:
            first_cell_text = row.locator("td:first-child").inner_text()
            if "/" in first_cell_text and len(first_cell_text.split("/")) == 3:
                try:
                    amount_text = row.locator("td:nth-child(2)").inner_text()
                    amount = float(amount_text.replace("$", "").replace(",", ""))
                except (ValueError, Exception):
                    amount = 0.0

                bills.append({"date": first_cell_text, "amount": amount})

        return bills

    def download_bill(self, bill_date: str) -> Path:
        """
        Download PDF for a specific bill date.
        Returns: Path to downloaded PDF file
        """
        self._navigate_to_billing_history()

        # Find and click the bill row
        all_rows = self._page.locator("table.app-table tbody tr").all()
        for row in all_rows:
            if row.locator("td:first-child").inner_text() == bill_date:
                row.locator("a.view-bill-link").click()
                break
        else:
            raise ValueError(f"Bill not found for date: {bill_date}")

        self._page.wait_for_url("**/ViewBill.aspx", timeout=25000)

        # Download PDF
        with self._page.expect_download() as download_info:
            self._page.locator("#main_divBillToolBar #main_PDF").click()

        download = download_info.value
        temp_path = Path(f"/tmp/bill_{bill_date.replace('/', '-')}.pdf")
        download.save_as(temp_path)

        return temp_path

    def close(self):
        """Close the browser and clean up resources."""
        if self._browser:
            self._browser.close()
        if self._playwright:
            self._playwright.stop()
        self._logged_in = False
```

### NextCentury Meters Scraper

[`scraper/scrapers/nextcentury_meters.py`](scraper/scrapers/nextcentury_meters.py)

**Class: NextCenturyMetersScraper**

```python
@dataclass
class UnitReading:
    """Represents a meter reading for a unit."""
    unit_id: str
    unit_name: str
    latest_date: str
    earliest_date: str
    usage_gallons: int
    usage_ccf: float
    latest_pulses: int
    earliest_pulses: int
    multiplier: int


class NextCenturyMetersScraper:
    """
    Scrapes meter readings from NextCentury Meters using their REST API.

    The approach:
    1. Login via browser to establish session and get JWT token from localStorage
    2. Use the JWT token to call the API directly for data

    Usage:
        scraper = NextCenturyMetersScraper(username, password, property_id)
        try:
            readings = scraper.get_readings_for_bill_period(start_date, end_date)
        finally:
            scraper.close()
    """

    BASE_URL = "https://app.nextcenturymeters.com"
    API_URL = "https://api.nextcenturymeters.com/api"

    def __init__(self, username: str, password: str, property_id: str):
        """Initialize with login credentials and property ID."""
        self.username = username
        self.password = password
        self.property_id = property_id
        self._playwright = None
        self._browser: Optional[Browser] = None
        self._context: Optional[BrowserContext] = None
        self._page: Optional[Page] = None
        self._auth_token: Optional[str] = None

    def _login(self):
        """Log into NextCentury website and extract JWT token."""
        if self._auth_token:
            return

        self._ensure_browser()
        self._page.goto(self.BASE_URL)
        self._page.wait_for_load_state("networkidle", timeout=25000)

        if self._page.locator('input[type="password"]').count() > 0:
            # Fill login form
            email_input = self._page.locator('input[type="email"]')
            if email_input.count() == 0:
                email_input = self._page.locator("input").first
            email_input.fill(self.username)
            self._page.locator('input[type="password"]').fill(self.password)
            self._page.locator('button[type="submit"]').click()

            try:
                self._page.wait_for_selector("text=Dashboard", timeout=15000)
            except Exception:
                self._page.locator('input[type="password"]').press("Enter")
                self._page.wait_for_selector("text=Dashboard", timeout=15000)

        # Extract JWT token from localStorage
        token = self._page.evaluate("() => localStorage.getItem('token')")
        if not token:
            raise Exception("Could not extract auth token from localStorage")

        self._auth_token = token

    def _get_units(self) -> List[dict]:
        """Get all units for the property."""
        self._login()
        headers: Dict[str, str] = {"Authorization": self._auth_token}
        url = f"{self.API_URL}/Properties/{self.property_id}/Units"
        response = self._page.request.get(url, headers=headers)
        if not response.ok:
            raise Exception(f"Failed to get units: {response.status}")
        return response.json()

    def get_current_readings(self, days: int = 60) -> Dict[str, dict]:
        """
        Get current meter readings for all units (in gallons, with CCF conversion).

        Args:
            days: Number of days to look back (default: 60)

        Returns:
            {"401": {"gallons": 1788, "ccf": 2.39, "start_date": "...", "end_date": "..."}}
        """
        to_date = datetime.now()
        from_date = to_date - timedelta(days=days)
        readings = self._get_readings_for_period(from_date, to_date)

        return {
            r.unit_name: {
                "gallons": r.usage_gallons,
                "ccf": r.usage_ccf,
                "start_date": r.earliest_date,
                "end_date": r.latest_date,
            }
            for r in readings
        }

    def get_readings_for_bill_period(self, bill_start_date: str, bill_end_date: str) -> Dict[str, dict]:
        """
        Get readings for a specific billing period.

        Args:
            bill_start_date: Period start (e.g., "Dec 01, 2024" or "12/01/2024")
            bill_end_date: Period end (e.g., "Dec 31, 2024" or "12/31/2024")

        Returns:
            {"401": {"gallons": 1788, "ccf": 2.39, "start_date": "...", "end_date": "..."}}
        """
        start_date = self._parse_date(bill_start_date)
        end_date = self._parse_date(bill_end_date)
        readings = self._get_readings_for_period(start_date, end_date)

        return {
            r.unit_name: {
                "gallons": r.usage_gallons,
                "ccf": r.usage_ccf,
                "start_date": r.earliest_date,
                "end_date": r.latest_date,
            }
            for r in readings
        }

    def _parse_date(self, date_str: str) -> datetime:
        """Parse various date string formats into datetime."""
        formats = [
            "%b %d, %Y",   # "Dec 01, 2024"
            "%B %d, %Y",   # "December 01, 2024"
            "%m/%d/%Y",    # "12/01/2024"
            "%Y-%m-%d",    # "2024-12-01"
        ]

        for fmt in formats:
            try:
                return datetime.strptime(date_str, fmt)
            except ValueError:
                continue

        raise ValueError(f"Could not parse date: {date_str}")

    def _get_readings_for_period(self, start_date: datetime, end_date: datetime) -> List[UnitReading]:
        """Get meter readings for a specific period."""
        self._login()

        from_str = start_date.strftime("%Y-%m-%dT%H:%M:%S.000Z")
        to_str = end_date.strftime("%Y-%m-%dT%H:%M:%S.000Z")

        units = self._get_units()
        readings = []
        headers: Dict[str, str] = {"Authorization": self._auth_token}

        for unit in units:
            unit_id_num = unit.get("id")
            unit_id = f"u_{unit_id_num}"
            unit_name = unit.get("name", "Unknown")

            url = f"{self.API_URL}/Units/{unit_id}/DailyReads?from={from_str}&to={to_str}"
            response = self._page.request.get(url, headers=headers)

            if not response.ok:
                continue

            daily_reads = response.json()
            if not daily_reads:
                continue

            earliest = daily_reads[0]
            latest = daily_reads[-1]

            earliest_pulses = earliest.get("latestRead", {}).get("pulseCount", 0)
            latest_pulses = latest.get("latestRead", {}).get("pulseCount", 0)
            multiplier = latest.get("latestRead", {}).get("multiplier", 1)

            # Usage in gallons (pulses * multiplier)
            usage_gallons = (latest_pulses - earliest_pulses) * multiplier
            usage_ccf = usage_gallons / 748.0

            readings.append(UnitReading(
                unit_id=unit_id,
                unit_name=unit_name,
                latest_date=latest.get("date", ""),
                earliest_date=earliest.get("date", ""),
                usage_gallons=usage_gallons,
                usage_ccf=round(usage_ccf, 2),
                latest_pulses=latest_pulses,
                earliest_pulses=earliest_pulses,
                multiplier=multiplier,
            ))

        return readings

    def close(self):
        """Close the browser and clean up resources."""
        if self._browser:
            self._browser.close()
        if self._playwright:
            self._playwright.stop()
        self._auth_token = None
```

### Bill Parser

[`scraper/parser.py`](scraper/parser.py)

**Class: BillParser**

Extracts structured data from Seattle Utilities PDF bills using PyPDF2 and regex patterns.

```python
# Regex Patterns
HEADER_REGEX = r"DUE DATE: (?P<due_date>[A-Za-z]+ \d{2}, \d{4})(?:.|\n)*Current billing: (?P<total>\d+\.\d{2})"
SERVICE_REGEX = r"(?P<service>[A-Za-z ]+)(?P<bill>(?:.|\n)+?)Current \1: (?P<total>\d+\.\d{2})"
USAGE_REGEX = r"(?P<start_date>\w{3} \d{2}, \d{4}) (?P<end_date>\w{3} \d{2}, \d{4}) (?P<usage>\d+.\d{2})\*?"
METER_REGEX = r"Meter Number: (?P<meter_number>[\w-]+) Service Category: ?(?P<service_category>\w*)"
ITEM_REGEX = r"^(?:(?P<start>\w{3} \d{2}, \d{4}) (?P<end>\w{3} \d{2}, \d{4}) *)?(?P<description>.+?)\s*(?:(?P<date>\w{3} \d{2}, \d{4}) *)?(?:(?P<usage>\d+\.\d{2}) CCF @ \$(?P<rate>\d+.\d{2}) per CCF )?(?P<cost>\d+\.\d{2})"
TRASH_REGEX = r"^(?P<count>\d+)-(?P<description>[\w /]+) (?P<size>\d+) Gal"


class BillParser:
    """Parses Seattle Utilities bill PDFs into structured data."""

    def parse(self, file_path: str) -> Dict[str, Any]:
        """
        Parse a bill PDF file and return structured data.

        Args:
            file_path: Path to the PDF file

        Returns:
            {
                "due_date": "January 13, 2025",
                "total": 425.67,
                "services": {
                    "Water": {"total": 150.00, "parts": [...]},
                    "Sewer": {"total": 200.00, "parts": [...]},
                    ...
                }
            }
        """
        reader = PdfReader(file_path)

        # Parse header from first page
        header = []
        reader.pages[0].extract_text(visitor_text=partial(self._visitor_body, header))
        header_text = "\n".join([part["text"].strip() for part in header])

        # Parse body from remaining pages
        body = []
        for page in reader.pages[1:]:
            page.extract_text(visitor_text=partial(self._visitor_body, body))
        body_text = "\n".join([part["text"].strip() for part in body])

        parsed_data = {
            **self._parse_header(header_text),
            "services": self._parse_services(body_text),
        }

        self._validate_bill(parsed_data)
        return parsed_data
```

**Service Names in Parsed Data:**

| Service Key        | Description                          |
| ------------------ | ------------------------------------ |
| `Water`            | Water consumption charges            |
| `Sewer`            | Sewer charges (based on water usage) |
| `Drainage`         | Stormwater drainage charges          |
| `Garbage`          | Garbage collection                   |
| `Recycling`        | Recycling collection                 |
| `Water Adjustment` | Water-related credits/debits         |
| `Sewer Adjustment` | Sewer-related credits/debits         |

### Auto-Populate Readings

[`scraper/main.py`](scraper/main.py) - `auto_populate_readings()` function

When a new bill is scraped, the scraper automatically fetches and populates meter readings:

```python
def auto_populate_readings(bill_id: str, parsed_data: dict, creds: dict) -> int:
    """
    Auto-populate meter readings for a new bill.
    Returns the number of readings populated.
    """
    try:
        # 1. Extract date range from water service
        water_service = parsed_data.get("services", {}).get("Water")
        if not water_service or not water_service.get("parts"):
            log.warning("No water service data found in bill")
            return 0

        first_part = water_service["parts"][0]
        start_date = first_part.get("start_date")
        end_date = first_part.get("end_date")

        if not start_date or not end_date:
            return 0

        # 2. Check NextCentury credentials
        nc_username = creds.get("nextcentury_username")
        nc_password = creds.get("nextcentury_password")
        nc_property = creds.get("nextcentury_property_id")

        if not nc_username or not nc_password or not nc_property:
            log.info("NextCentury credentials not configured")
            return 0

        # 3. Get configured units from Firestore
        units = list(db.collection("units").stream())
        if not units:
            return 0

        # 4. Fetch readings from NextCentury
        nc_scraper = NextCenturyMetersScraper(nc_username, nc_password, nc_property)

        try:
            readings = nc_scraper.get_readings_for_bill_period(start_date, end_date)

            if not readings:
                return 0

            # 5. Match readings to units and save
            readings_count = 0
            for unit_doc in units:
                unit = unit_doc.to_dict()
                unit_id = unit_doc.id
                unit_name = unit.get("name", "")
                submeter_id = unit.get("submeter_id", "")

                # Extract unit number from name (e.g., "Unit 401" -> "401")
                import re
                unit_number_match = re.search(r"\d+", unit_name)
                unit_number = unit_number_match.group() if unit_number_match else None

                if unit_number and unit_number in readings:
                    reading_data = readings[unit_number]
                    gallons = reading_data.get("gallons", 0)

                    # 6. Save to readings subcollection
                    db.collection("bills").document(bill_id).collection(
                        "readings"
                    ).document(unit_id).set({
                        "unit_id": unit_id,
                        "submeter_id": submeter_id,
                        "reading": gallons,
                        "created_at": firestore.SERVER_TIMESTAMP,
                        "auto_populated": True,
                    })

                    readings_count += 1

            # 7. Store latest readings in settings
            if readings:
                db.collection("settings").document("latest_readings").set({
                    "readings": readings,
                    "fetched_at": firestore.SERVER_TIMESTAMP,
                    "unit": "gallons",
                    "period": {"start_date": start_date, "end_date": end_date},
                })

            return readings_count

        finally:
            nc_scraper.close()

    except Exception as e:
        log.error(f"Error auto-populating readings: {e}", exc_info=True)
        return 0
```

---

## Security Rules

### Firestore Rules ([`firestore.rules`](firestore.rules))

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Helper: Check if user is admin
    function isAdmin() {
      return request.auth != null &&
        exists(/databases/$(database)/documents/users/$(request.auth.token.email)) &&
        get(/databases/$(database)/documents/users/$(request.auth.token.email)).data.role == 'admin';
    }

    // Helper: Check if user is registered (admin or member)
    function isRegisteredUser() {
      return request.auth != null &&
        exists(/databases/$(database)/documents/users/$(request.auth.token.email));
    }

    // Helper: Check if user is bootstrap admin (for initial setup)
    function isBootstrapAdmin() {
      return request.auth != null &&
        request.auth.token.email == 'jvenberg@gmail.com';
    }

    // Users collection - for role management
    match /users/{userEmail} {
      allow read: if request.auth != null;
      allow create: if isAdmin() || (isBootstrapAdmin() && userEmail == 'jvenberg@gmail.com');
      allow update, delete: if isAdmin();
    }

    // Units collection - main data
    match /units/{unitId} {
      allow read: if isRegisteredUser();
      allow write: if isAdmin();
    }

    // Bills collection - utility bills
    match /bills/{billId} {
      allow read: if isRegisteredUser();
      allow write: if isRegisteredUser();  // Members can approve bills

      // Subcollections
      match /readings/{readingId} {
        allow read, write: if isRegisteredUser();
      }
      match /adjustments/{adjustmentId} {
        allow read, write: if isRegisteredUser();
      }
      match /invoices/{invoiceId} {
        allow read, write: if isRegisteredUser();
      }
    }

    // Gmail tokens - for OAuth storage
    match /gmail_tokens/{tokenId} {
      allow read, write: if isAdmin();
    }

    // Settings/config
    match /settings/{settingId} {
      allow read: if request.auth != null;
      allow write: if isAdmin();
    }
  }
}
```

### Storage Rules ([`storage.rules`](storage.rules))

```javascript
rules_version = '2';

service firebase.storage {
  match /b/{bucket}/o {
    // Bill PDFs - stored under /bills/{billId}/
    match /bills/{allPaths=**} {
      allow read: if true;  // Public read for PDF viewing
      allow write: if request.auth != null;
    }

    // Default: deny all other paths
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}
```

### Permission Summary

| Collection/Path         | Read              | Write                            |
| ----------------------- | ----------------- | -------------------------------- |
| `users/*`               | Any authenticated | Admin only (bootstrap exception) |
| `units/*`               | Registered users  | Admin only                       |
| `bills/*`               | Registered users  | Registered users                 |
| `bills/*/readings/*`    | Registered users  | Registered users                 |
| `bills/*/adjustments/*` | Registered users  | Registered users                 |
| `bills/*/invoices/*`    | Registered users  | Registered users                 |
| `settings/*`            | Any authenticated | Admin only                       |
| `storage/bills/*`       | Anyone            | Authenticated users              |

---

## Configuration

### Firebase Project

- **Project ID**: `utilitysplitter`
- **Region**: `us-central1`
- **Hosting URL**: https://utilitysplitter.web.app
- **Functions URL**: https://us-central1-utilitysplitter.cloudfunctions.net/

### Environment Variables

#### Functions (`functions/.env`)

```bash
# Scraper service URL (Cloud Run)
SCRAPER_URL=https://utility-scraper-1091648531062.us-central1.run.app

# Gmail OAuth credentials (from Google Cloud Console)
GMAIL_CLIENT_ID=xxx.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=GOCSPX-xxx
```

#### Web (`web/.env.local`)

```bash
# Firebase configuration
VITE_FIREBASE_API_KEY=xxx
VITE_FIREBASE_AUTH_DOMAIN=utilitysplitter.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=utilitysplitter
VITE_FIREBASE_STORAGE_BUCKET=utilitysplitter.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=xxx
VITE_FIREBASE_APP_ID=xxx

# Bootstrap admin email (can initialize first admin without existing admin)
VITE_BOOTSTRAP_ADMIN_EMAIL=jvenberg@gmail.com
```

### Key URLs

| Service              | URL                                                                       |
| -------------------- | ------------------------------------------------------------------------- |
| Web App              | https://utilitysplitter.web.app                                           |
| Cloud Run Scraper    | https://utility-scraper-1091648531062.us-central1.run.app                 |
| Gmail OAuth Callback | https://us-central1-utilitysplitter.cloudfunctions.net/gmailOAuthCallback |
| Seattle Utilities    | https://myutilities.seattle.gov                                           |
| NextCentury Meters   | https://app.nextcenturymeters.com                                         |
| NextCentury API      | https://api.nextcenturymeters.com/api                                     |

### Firebase Configuration ([`firebase.json`](firebase.json))

```json
{
  "firestore": {
    "rules": "firestore.rules",
    "indexes": "firestore.indexes.json"
  },
  "functions": {
    "source": "functions",
    "codebase": "default",
    "runtime": "nodejs20"
  },
  "hosting": {
    "public": "web/dist",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "rewrites": [{ "source": "**", "destination": "/index.html" }]
  },
  "storage": {
    "rules": "storage.rules"
  }
}
```

---

## Development Commands

### Prerequisites

- **Node.js 20** (see `.nvmrc`)
- **Python 3.13+** (for scraper)
- **Firebase CLI**: `npm install -g firebase-tools`
- **Docker** (for scraper local testing)
- **uv** (Python package manager): `pip install uv`
- **Google Cloud SDK** (for Cloud Run deployment)

### Web Application

```bash
cd web

# Install dependencies
npm install

# Start development server (http://localhost:5173)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Type check
npx tsc --noEmit

# Lint
npm run lint

# Lint with auto-fix
npm run lint -- --fix
```

### Cloud Functions

```bash
cd functions

# Install dependencies
npm install

# Compile TypeScript
npm run build

# Watch mode (recompile on changes)
npm run build:watch

# Start Firebase emulators (includes functions)
npm run serve

# Deploy functions only
npm run deploy
# or
firebase deploy --only functions

# Deploy a specific function
firebase deploy --only functions:sendInvoiceEmail

# View function logs
firebase functions:log
firebase functions:log --only fetchMeterReadings
```

### Scraper Service

```bash
cd scraper

# Install uv if needed
pip install uv

# Install dependencies
uv sync

# Install Playwright browsers
uv run playwright install chromium

# Run Flask locally (debug mode)
uv run flask run --port 8080 --debug

# Or run directly
uv run python main.py

# Build Docker image
docker build -t utility-scraper .

# Run Docker locally
docker run -p 8080:8080 \
  -e GOOGLE_APPLICATION_CREDENTIALS=/app/service-account.json \
  -v /path/to/service-account.json:/app/service-account.json \
  utility-scraper

# Test health endpoint
curl http://localhost:8080/health

# Test readings endpoint
curl -X POST http://localhost:8080/readings \
  -H "Content-Type: application/json" \
  -d '{"start_date": "Dec 01, 2024", "end_date": "Dec 31, 2024"}'

# Test scrape endpoint
curl -X POST http://localhost:8080/scrape \
  -H "Content-Type: application/json" \
  -d '{"type": "all"}'

# Deploy to Cloud Run
gcloud run deploy utility-scraper \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 1Gi \
  --timeout 300
```

### Firebase CLI

```bash
# Login to Firebase
firebase login

# Select project
firebase use utilitysplitter

# Deploy everything
firebase deploy

# Deploy specific services
firebase deploy --only hosting
firebase deploy --only functions
firebase deploy --only firestore:rules
firebase deploy --only storage:rules

# Deploy hosting and functions together
firebase deploy --only hosting,functions

# View deployment status
firebase hosting:channel:list

# View function logs
firebase functions:log --project utilitysplitter

# View specific function logs
firebase functions:log --only sendAllInvoices --project utilitysplitter
```

---

## Deployment

### Full Deployment Checklist

```bash
# 1. Ensure you're logged in and using correct project
firebase login
firebase use utilitysplitter

# 2. Build web app
cd web
npm install
npm run build

# 3. Build functions
cd ../functions
npm install
npm run build

# 4. Deploy Firebase (hosting + functions + rules)
cd ..
firebase deploy

# 5. Deploy scraper to Cloud Run (if changed)
cd scraper
gcloud run deploy utility-scraper \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 1Gi \
  --timeout 300
```

### Deployment Outputs

- **Web App**: Built to `web/dist/`, served from Firebase Hosting
- **Functions**: Compiled to `functions/lib/`, deployed to Cloud Functions
- **Scraper**: Docker image built and deployed to Cloud Run

### Cloud Function Timeouts and Resources

| Function             | Timeout       | Memory |
| -------------------- | ------------- | ------ |
| triggerScraperManual | 540s (9 min)  | 256MB  |
| fetchMeterReadings   | 120s (2 min)  | 256MB  |
| sendReminders        | 60s (default) | 256MB  |
| Others               | 60s (default) | 256MB  |

---

## Workflows

### Bill Processing Workflow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         BILL PROCESSING WORKFLOW                         │
└─────────────────────────────────────────────────────────────────────────┘

1. SCRAPE (Automatic or Manual)
   ├── Scheduled: Cloud Scheduler triggers every 3 days at 6 AM
   └── Manual: Settings → "Run Scraper Now" button
         │
         ▼
2. BILL CREATED + AUTO-POPULATE READINGS
   ├── Scraper downloads PDF from Seattle Utilities
   ├── Parser extracts structured data (services, amounts, dates)
   ├── PDF uploaded to Cloud Storage
   ├── Bill document created in Firestore with status:
   │   • NEW (no adjustments)
   │   • NEEDS_REVIEW (has adjustments)
   ├── Adjustments saved to subcollection
   ├── Scraper auto-fetches readings from NextCentury for bill period
   └── Readings saved to bill's readings/ subcollection
         │
         ▼
3. REVIEW BILL (Admin/Member)
   ├── Navigate to Bills → Click on bill
   ├── View bill summary and PDF
   │
   │ [IF READINGS NEEDED]
   ├── Readings are usually AUTO-POPULATED
   ├── Status box shows "6 readings loaded — Values pre-populated below"
   ├── Click "Refresh from Meters" to re-fetch if needed
   ├── Verify or manually adjust readings as needed
   └── Click "Save Readings" to persist changes
         │
         ▼
4. ASSIGN ADJUSTMENTS (if bill has adjustments)
   ├── Only appears for NEEDS_REVIEW status
   ├── Each adjustment shows description and amount
   ├── Check boxes to select which units share each adjustment
   └── Adjustments are split evenly among selected units
         │
         ▼
5. REVIEW INVOICES
   ├── Preview section shows calculated invoices
   ├── Each unit shows:
   │   • Unit name and tenant email
   │   • Total amount
   │   • Line items (water, sewer, adjustments, etc.)
   └── Verify amounts are correct
         │
         ▼
6. APPROVE & SEND
   ├── Click "Mark Ready for Approval" (if NEEDS_REVIEW)
   │   └── Status changes to PENDING_APPROVAL
   │
   ├── Click "Approve & Send Invoices" (if PENDING_APPROVAL)
   │   ├── Invoices saved to Firestore
   │   ├── Emails sent to each tenant via Gmail API
   │   └── Bill status changes to INVOICED
         │
         ▼
7. TRACK PAYMENTS
   ├── View invoices on BillDetail page
   ├── Click "Mark as Paid" when payment received
   │   └── Invoice status changes to PAID
   │
   └── Automated reminders (if configured):
       ├── Day 7: First reminder email
       └── Day 14: Second reminder email
```

### First-Time Setup Workflow

```
1. DEPLOY APPLICATION
   ├── Deploy Firebase (hosting, functions, rules)
   └── Deploy Cloud Run scraper

2. CONFIGURE BOOTSTRAP ADMIN
   ├── Set VITE_BOOTSTRAP_ADMIN_EMAIL in web/.env.local
   └── Rebuild and redeploy web app

3. INITIALIZE ADMIN
   ├── Sign in with bootstrap admin email (Google Sign-In)
   ├── Navigate to Settings
   └── Click "Initialize as Admin"

4. CONFIGURE UTILITY CREDENTIALS
   ├── Seattle Utilities:
   │   • Account number
   │   • Username
   │   • Password
   └── NextCentury (optional):
       • Property ID
       • Username
       • Password

5. CONNECT GMAIL
   ├── Click "Connect Gmail Account"
   ├── Sign in with
```
