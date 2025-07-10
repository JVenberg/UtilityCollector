# Technical Plan: HOA Utility Billing System

This document outlines the architecture and implementation plan for a system to manage, split, and invoice utility bills for a multi-unit HOA.

## 1. High-Level Architecture

The system will be a containerized web application with a background scheduler designed for long-term operation on a home server.

- **Scheduler:** A background job will run daily to download new utility bills and create initial entries in the database.
- **Web Application:** A FastAPI web server will provide a UI to manage the entire workflow, from triggering bill splits to tracking payments.
- **Database:** A SQLite database will persist all application state.
- **Containerization:** The entire system will be managed via Docker and Docker Compose, with Docker volumes used to persist data on the host filesystem.

## 2. Technology Stack

- **Backend Framework:** FastAPI
- **Database ORM:** SQLModel
- **Database Migrations:** Alembic
- **Job Scheduling:** APScheduler
- **PDF Parsing:** PyPDF2 (via existing `bill_parser.py`)
- **Email Service:** google-api-python-client (for Gmail API)
- **Containerization:** Docker & Docker Compose
- **Code Formatting:** Black, isort

## 3. System Components & Workflow

The system operates in two main phases: an automated daily job and a manual user-driven workflow.

```mermaid
graph TD
    subgraph "Docker Environment (Home Server)"
        subgraph "Docker Compose"
            WebApp[/"FastAPI Web App (Uvicorn)"/]
            Scheduler[/"APScheduler (runs in WebApp thread)"/]
            Database[(SQLite DB)]
            BillStorage[Bill PDFs]
            LogStorage[Rotating Logs]
        end
    end

    User[You] -- Manages via Web UI --> WebApp;

    subgraph "Automated Nightly Job"
        Scheduler -- Triggers Daily --> BillPuller(pull_bill.py logic);
        BillPuller -- Downloads New Bill --> BillStorage;
        BillPuller -- Creates 'Bill' entry in DB (status: NEW) --> WebApp;
    end

    subgraph "Manual Invoicing Workflow (in Web UI)"
        Step1[1. User clicks "Split Bill"] --> WebApp;
        WebApp -- Prompts for Submeter Data --> User;
        User -- Enters Submeter Data --> WebApp;
        WebApp -- Runs Splitting Logic --> InvoiceGen(Generates invoice data);
        InvoiceGen -- Saves invoice data to DB --> Database;
        Step2[2. User reviews split, assigns adjustments] --> WebApp;
        WebApp -- Updates invoice data --> Database;
        Step3[3. User clicks "Send Invoices"] --> WebApp;
        WebApp -- Sends Emails via Gmail API --> Gmail[External: Gmail API];
        Step4[4. User tracks payments] --> WebApp;
        WebApp -- Updates payment status --> Database;
    end

    OtherUnits[Unit Residents] -- Receive Invoices --> Gmail;
```

## 4. Database Schema

The database will be structured using the following SQLModel tables. This design is normalized to reduce data redundancy and ensure integrity.

```python
# app/db/models.py

from typing import List, Optional
from sqlmodel import Field, Relationship, SQLModel

class Unit(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(unique=True) # e.g., "Unit 401"
    sqft: int
    submeter_id: str
    email: str

    trash_cans: List["TrashCan"] = Relationship(back_populates="unit")
    invoices: List["Invoice"] = Relationship(back_populates="unit")

class TrashCan(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    service_type: str  # "Garbage", "Recycle", etc.
    size: int  # in Gallons

    unit_id: int = Field(foreign_key="unit.id")
    unit: Unit = Relationship(back_populates="trash_cans")

class Bill(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    bill_date: str # The date of the bill document
    due_date: str
    total_amount: float
    pdf_path: str = Field(unique=True)
    status: str  # e.g., "NEW", "PROCESSING", "INVOICED", "PAID"

    invoices: List["Invoice"] = Relationship(back_populates="bill")

class Invoice(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    total_amount: float
    payment_status: str # "UNPAID", "PAID"

    unit_id: int = Field(foreign_key="unit.id")
    unit: Unit = Relationship(back_populates="invoices")

    bill_id: int = Field(foreign_key="bill.id")
    bill: Bill = Relationship(back_populates="invoices")

    line_items: List["LineItem"] = Relationship(back_populates="invoice")

class LineItem(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    description: str
    cost: float
    is_adjustment: bool = False

    invoice_id: int = Field(foreign_key="invoice.id")
    invoice: Invoice = Relationship(back_populates="line_items")
```

## 5. Project Structure

The project will be organized as follows to promote separation of concerns.

```
/utility-billing-system
|-- docker-compose.yml
|-- Dockerfile
|-- Makefile
|-- .env.example
|-- alembic.ini             # Alembic configuration
|-- app/
|   |-- __init__.py
|   |-- main.py             # FastAPI app init, scheduler startup
|   |-- core/
|   |   |-- config.py       # Pydantic settings management
|   |   |-- logging_config.py # Logging setup
|   |-- db/
|   |   |-- models.py       # SQLModel classes
|   |   |-- crud.py         # Database interaction functions
|   |   |-- database.py     # Database engine and session setup
|   |   |-- migrations/     # Alembic migration scripts
|   |       |-- versions/
|   |       |-- env.py
|   |       |-- script.py.mako
|   |-- web/
|   |   |-- routers/        # API endpoints
|   |   |-- templates/      # Jinja2 HTML templates
|   |   |-- static/         # CSS/JS files
|   |-- services/
|   |   |-- bill_manager.py # Combines puller and parser
|   |   |-- invoice_service.py # Core splitting logic
|   |   |-- email_service.py # Gmail integration
|   |-- jobs/
|   |   |-- pull_bills_job.py # Scheduled job function
|-- data/                   # Mounted Docker volume
|   |-- bills/
|   |-- database.db
|   |-- logs/
|-- pyproject.toml          # Project dependencies for uv
```

## 6. Development & Deployment

A `Makefile` will be provided to streamline common tasks.

- **`make build`**: Build the Docker image for the application.
- **`make up`**: Start the application using `docker-compose`.
- **`make down`**: Stop the application.
- **`make logs`**: Follow the application logs.
- **`make revision`**: Create a new Alembic database migration file after changing models.
- **`make migrate`**: Apply any pending database migrations.

Authentication will be handled externally by an Nginx proxy; the application will simply run on its exposed port within the Docker network.

---

## 7. Step-by-Step Implementation Plan

This plan is designed to be iterative, delivering testable functionality at each step.

### Phase 1: Core Backend Setup & Bill Polling

**Goal:** Establish the project foundation and automate the daily pulling and parsing of bills into the database.

1.  **Project Scaffolding:**

    - **Action:** Create the full directory structure as outlined above.
    - **Files:** `app/main.py`, `app/core/config.py`, `app/db/database.py`, etc.
    - **Test:** The directory structure exists.

2.  **Dependencies & Environment:**

    - **Action:** Initialize the project with `uv init`. Add all necessary dependencies (`fastapi`, `uvicorn`, `sqlmodel`, `alembic`, `apscheduler`, `google-api-python-client`, etc.) to the `pyproject.toml` file. Create a `.env.example` file for environment variables.
    - **Files:** `pyproject.toml`, `.env.example`.
    - **Test:** `uv pip sync` runs successfully and installs the dependencies.

3.  **Configuration & Logging:**

    - **Action:** Implement `core/config.py` using Pydantic `BaseSettings` to load environment variables. Implement `core/logging_config.py` to set up timed, rotating file logs.
    - **Files:** `app/core/config.py`, `app/core/logging_config.py`.
    - **Test:** The FastAPI app can start and correctly log to a file in `data/logs`.

4.  **Database Models & Initial Migration:**

    - **Action:** Define all `SQLModel` classes in `db/models.py`. Initialize Alembic and create the first migration script that generates the entire schema.
    - **Files:** `app/db/models.py`, `alembic.ini`, `app/db/migrations/`.
    - **Test:** Run `make revision --autogenerate` and `make migrate`. Verify the `database.db` file is created with the correct tables.

5.  **Bill Management Service:**

    - **Action:** Refactor the logic from `pull_bill.py` and `bill_parser.py` into a new `services/bill_manager.py`. This service will contain functions to:
      1.  Download the latest bill.
      2.  Check if the bill's PDF path already exists in the database (`crud.py` function needed).
      3.  If new, parse the bill.
      4.  Save the `Bill` object to the database (`crud.py` function needed).
    - **Files:** `app/services/bill_manager.py`, `app/db/crud.py`.
    - **Test:** Manually run the service's main function and verify a new bill is added to the DB and the PDF is saved.

6.  **Scheduler Integration:**

    - **Action:** Create the job function in `jobs/pull_bills_job.py` that calls the bill manager service. In `app/main.py`, configure and start APScheduler to run this job on a schedule (e.g., every minute for testing, later daily).
    - **Files:** `app/jobs/pull_bills_job.py`, `app/main.py`.
    - **Test:** Run the app and wait for the scheduled job to trigger, verifying a new bill is processed automatically.

7.  **Containerization:**
    - **Action:** Write the `Dockerfile` to create the application image. The Dockerfile will use `uv pip sync` to install dependencies from `pyproject.toml`. Write the `docker-compose.yml` to define the app service and the `data` volume mounts.
    - **Files:** `Dockerfile`, `docker-compose.yml`.
    - **Test:** Run `make build` and `make up`. The application should start, and the bill polling job should run inside the container.

### Phase 2: Web UI - Bill Management & Splitting

**Goal:** Build the web interface for managing bills and implementing the user-driven splitting workflow.

1.  **Bills Dashboard:**

    - **Action:** Create a FastAPI router (`web/routers/bills.py`) with an endpoint to fetch all bills. Create an HTML template (`web/templates/bills.html`) to display the bills in a table, showing their date, total, and status.
    - **Files:** `app/web/routers/bills.py`, `app/web/templates/bills.html`.
    - **Test:** Open the web browser to the bills page and see the list of bills pulled in Phase 1.

2.  **Unit Management UI:**

    - **Action:** Create API endpoints and templates for basic CRUD (Create, Read, Update, Delete) operations for the `Unit` and `TrashCan` models. This will allow you to set up the HOA unit details (sqft, email, etc.).
    - **Files:** `app/web/routers/units.py`, `app/web/templates/units.html`.
    - **Test:** Use the web UI to add/edit the three HOA units and their associated trash can sizes.

3.  **Bill Splitting Workflow:**
    - **Action:** This is the core interactive feature.
      1.  Add a "Split Bill" button to the bills dashboard.
      2.  This leads to a new page that shows the parsed bill details.
      3.  This page will have input fields for the submeter readings for each unit.
      4.  Implement the logic in `services/invoice_service.py` to perform the splits based on the logic from `main.py`.
      5.  The page will then display a proposed invoice for each unit and have a form for adding/assigning manual adjustments.
      6.  A "Save Invoice" button will store all `Invoice` and `LineItem` data in the database.
    - **Files:** `app/services/invoice_service.py`, new functions in `web/routers/bills.py`, new templates.
    - **Test:** Go through the full workflow for a single bill and verify the correct invoice data is saved to the database.

### Phase 3: Invoicing and Payment Tracking

**Goal:** Finalize the workflow by adding email notifications and payment tracking.

1.  **Email Service & Invoicing:**

    - **Action:** Implement `services/email_service.py` to send emails using the Gmail API. Create an HTML template for the invoice email. Add a "Send Invoices" button to the bill detail page that triggers this service.
    - **Files:** `app/services/email_service.py`, `app/web/templates/invoice_email.html`.
    - **Test:** Click the "Send Invoices" button and verify that all units receive a correct, formatted invoice email.

2.  **Payment Tracking:**

    - **Action:** In the UI, add controls (e.g., buttons) to mark each unit's invoice as "Paid" and to mark the main utility `Bill` as "Paid". These actions will update the `status` fields in the database.
    - **Files:** Updates to bill/invoice templates and routers.
    - **Test:** Mark invoices as paid and see the status update correctly in the web UI.

3.  **Reminders:**
    - **Action:** Add a "Send Reminders" button that emails only the units with "Unpaid" invoices for a given bill.
    - **Test:** Mark one invoice as paid, then click "Send Reminders" and verify only the unpaid units receive a reminder email.
