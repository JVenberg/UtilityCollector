# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

Automated HOA utility billing system using Firebase/Cloud Run:

- React SPA frontend with Firebase SDK (Firestore, Auth, Storage)
- Cloud Functions for email sending and scheduled tasks
- Cloud Run for Playwright-based web scraping
- Auto-scrapes bills from Seattle Utilities
- Calculates and sends invoices to tenants via Gmail
- Payment tracking with reminder emails

## Architecture

```
React SPA (Firebase Hosting)
    │
    ├─► Firestore (bills, units, settings, users)
    ├─► Firebase Auth (Google sign-in)
    ├─► Cloud Storage (bill PDFs)
    │
    └─► Cloud Functions
          ├─► sendAllInvoices (email via Gmail API)
          ├─► sendReminders (scheduled daily)
          ├─► triggerScraper (scheduled every 3 days)
          └─► Gmail OAuth flow

Cloud Run (scraper/)
    └─► Playwright scraper for Seattle Utilities
```

## Project Structure

```
/
├── web/                    # React SPA (Vite + TypeScript)
│   ├── src/
│   │   ├── pages/         # React pages (Bills, Units, Settings)
│   │   ├── hooks/         # Custom hooks (useAuth, useBills, useUnits, useUsers)
│   │   ├── services/      # Invoice calculator
│   │   ├── types/         # TypeScript types
│   │   └── firebase.ts    # Firebase SDK config
│   └── package.json
│
├── functions/             # Cloud Functions (TypeScript)
│   ├── src/index.ts       # All functions
│   ├── .env               # Environment variables (SCRAPER_URL, GMAIL_*)
│   └── package.json
│
├── scraper/               # Cloud Run scraper (Python)
│   ├── main.py            # FastAPI app
│   ├── scrapers/          # Playwright scrapers
│   └── Dockerfile
│
├── firebase.json          # Firebase config
├── firestore.rules        # Firestore security rules
├── storage.rules          # Cloud Storage rules
└── gcreds/                # OAuth credentials (not committed)
```

## Development Commands

```bash
# React app (web/)
cd web && npm run dev          # Start dev server
cd web && npm run build        # Build for production

# Cloud Functions (functions/)
cd functions && npm run build  # Compile TypeScript
firebase deploy --only functions

# Deploy everything
firebase deploy --project utilitysplitter

# Scraper (Cloud Run)
cd scraper && docker build -t utility-scraper .
gcloud run deploy utility-scraper --source ./scraper

# View function logs
firebase functions:log --project utilitysplitter
```

## Key URLs

- **Web App**: https://utilitysplitter.web.app
- **Scraper**: https://utility-scraper-1091648531062.us-central1.run.app
- **OAuth Callback**: https://us-central1-utilitysplitter.cloudfunctions.net/gmailOAuthCallback

## Firebase Project

- **Project ID**: utilitysplitter
- **Region**: us-central1

## Environment Variables

### functions/.env

```
SCRAPER_URL=https://utility-scraper-xxx.run.app
GMAIL_CLIENT_ID=xxx.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=GOCSPX-xxx
```

### web/.env.local

```
VITE_FIREBASE_API_KEY=xxx
VITE_FIREBASE_AUTH_DOMAIN=utilitysplitter.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=utilitysplitter
VITE_FIREBASE_STORAGE_BUCKET=utilitysplitter.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=xxx
VITE_FIREBASE_APP_ID=xxx
VITE_BOOTSTRAP_ADMIN_EMAIL=admin@example.com
```

## Data Flow

1. **Scraper** runs every 3 days (or manually triggered)
2. Scraper downloads bills from Seattle Utilities
3. Bills stored in Firestore with PDFs in Cloud Storage
4. User reviews bill in web app, enters meter readings
5. User approves → Cloud Function sends invoices via Gmail
6. Daily scheduled function sends payment reminders

## User Roles

- **admin**: Full access (manage settings, users, approve bills)
- **member**: View and approve bills only

## Key Firestore Collections

- `bills/` - Utility bills with status (NEW, INVOICED)
- `units/` - Property units with tenant info
- `users/` - App users with roles
- `settings/` - Credentials, Gmail token, scraper status
