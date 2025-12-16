"""
Cloud Run Scraper Service

This service handles all Playwright-based scraping for:
- Seattle Utilities (bills)
- NextCentury Meters (readings)

It's triggered by Cloud Scheduler and writes results to Firestore.
"""

import logging
import os

from firebase_admin import credentials
from firebase_admin import firestore
from firebase_admin import initialize_app
from firebase_admin import storage
from flask import Flask
from flask import jsonify
from flask import request

# Initialize Firebase
cred = credentials.ApplicationDefault()
initialize_app(
    cred,
    {
        "storageBucket": f"{os.environ.get('GCP_PROJECT_ID', 'utilitysplitter')}.firebasestorage.app"
    },
)
db = firestore.client()
bucket = storage.bucket()

from parser import BillParser

from scrapers.nextcentury_meters import NextCenturyMetersScraper

# Import scrapers
from scrapers.seattle_utilities import SeattleUtilitiesScraper

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)


@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint."""
    return jsonify({"status": "healthy"})


@app.route("/scrape", methods=["POST"])
def scrape():
    """
    Main scraping endpoint. Dispatches to the appropriate scraper based on type.

    Request body:
    {
        "type": "seattle_utilities" | "nextcentury_meters" | "all",
        "community_id": "optional-community-id"
    }
    """
    try:
        data = request.get_json() or {}
        scrape_type = data.get("type", "all")
        community_id = data.get("community_id")

        results = {
            "success": True,
            "seattle_utilities": None,
            "nextcentury_meters": None,
        }

        if scrape_type in ["seattle_utilities", "all"]:
            results["seattle_utilities"] = scrape_seattle_utilities()

        if scrape_type in ["nextcentury_meters", "all"]:
            results["nextcentury_meters"] = scrape_nextcentury_meters()

        return jsonify(results)

    except Exception as e:
        log.error(f"Scraping error: {e}", exc_info=True)
        return jsonify({"success": False, "error": str(e)}), 500


def get_utility_credentials():
    """Fetch utility credentials from Firestore settings collection."""
    try:
        creds_doc = db.collection("settings").document("utility_credentials").get()
        if creds_doc.exists:
            return creds_doc.to_dict()
        return None
    except Exception as e:
        log.error(f"Error fetching credentials from Firestore: {e}")
        return None


def scrape_seattle_utilities():
    """Scrape Seattle Utilities for new bills."""
    log.info("Starting Seattle Utilities scrape...")

    # Get credentials from Firestore
    creds = get_utility_credentials()

    if not creds:
        log.error("No utility credentials found in Firestore")
        return {
            "error": "Missing credentials - please configure in Settings",
            "new_bills": [],
        }

    username = creds.get("seattle_utilities_username")
    password = creds.get("seattle_utilities_password")
    account = creds.get("seattle_utilities_account", "4553370429")

    if not username or not password:
        log.error("Missing Seattle Utilities credentials in Firestore")
        return {
            "error": "Missing Seattle Utilities credentials - please configure in Settings",
            "new_bills": [],
        }

    scraper = SeattleUtilitiesScraper(username, password, account)
    parser = BillParser()

    try:
        # Check for available bills
        bills = scraper.check_for_new_bills()
        new_bills = []

        for bill_info in bills:
            # Check if already exists in Firestore
            existing = list(
                db.collection("bills")
                .where("bill_date", "==", bill_info["date"])
                .limit(1)
                .stream()
            )

            if existing:
                log.info(f"Bill {bill_info['date']} already exists, skipping")
                continue

            log.info(f"Downloading new bill: {bill_info['date']}")

            # Download PDF
            pdf_path = scraper.download_bill(bill_info["date"])

            # Parse bill
            parsed_data = parser.parse(str(pdf_path))

            # Upload PDF to Storage
            blob_name = f"bills/{bill_info['date'].replace('/', '-')}.pdf"
            blob = bucket.blob(blob_name)
            blob.upload_from_filename(str(pdf_path))
            pdf_url = f"gs://{bucket.name}/{blob_name}"

            # Determine if bill has adjustments
            has_adjustments = any(
                "adjustment" in service.lower()
                for service in parsed_data.get("services", {}).keys()
            )

            # Create Firestore document
            bill_ref = db.collection("bills").document()
            bill_data = {
                "bill_date": bill_info["date"],
                "due_date": parsed_data["due_date"],
                "total_amount": parsed_data["total"],
                "pdf_url": pdf_url,
                "status": "NEEDS_REVIEW" if has_adjustments else "PENDING_APPROVAL",
                "has_adjustments": has_adjustments,
                "parsed_data": parsed_data,
                "created_at": firestore.SERVER_TIMESTAMP,
                "approved_at": None,
                "approved_by": None,
            }
            bill_ref.set(bill_data)

            # Extract and save adjustments as subcollection
            adjustments = extract_adjustments(parsed_data)
            for adj in adjustments:
                db.collection("bills").document(bill_ref.id).collection(
                    "adjustments"
                ).add(
                    {
                        "description": adj["description"],
                        "cost": adj["cost"],
                        "date": adj.get("date"),
                        "assigned_unit_ids": [],
                    }
                )

            new_bills.append(
                {
                    "id": bill_ref.id,
                    "date": bill_info["date"],
                    "amount": bill_info["amount"],
                }
            )

            log.info(f"Successfully saved bill {bill_info['date']}")

            # Clean up temp file
            pdf_path.unlink()

        return {"new_bills": new_bills, "total_checked": len(bills)}

    finally:
        scraper.close()


def scrape_nextcentury_meters():
    """Scrape NextCentury Meters for current readings."""
    log.info("Starting NextCentury Meters scrape...")

    # Get credentials from Firestore
    creds = get_utility_credentials()

    if not creds:
        log.warning("No utility credentials found in Firestore")
        return {"error": "Missing credentials", "readings": {}}

    username = creds.get("nextcentury_username")
    password = creds.get("nextcentury_password")
    property_id = creds.get("nextcentury_property_id")

    if not username or not password:
        log.warning("Missing NextCentury credentials, skipping")
        return {"error": "Missing NextCentury credentials", "readings": {}}

    scraper = NextCenturyMetersScraper(username, password, property_id)

    try:
        readings = scraper.get_current_readings()

        # Store readings in settings or a dedicated collection
        if readings:
            db.collection("settings").document("latest_readings").set(
                {
                    "readings": readings,
                    "fetched_at": firestore.SERVER_TIMESTAMP,
                }
            )

        return {"readings": readings}

    finally:
        scraper.close()


def extract_adjustments(parsed_data: dict) -> list:
    """Extract adjustment items from parsed bill data."""
    adjustments = []

    for service_name, service_data in parsed_data.get("services", {}).items():
        if "adjustment" in service_name.lower():
            for part in service_data.get("parts", []):
                for item in part.get("items", []):
                    adjustments.append(
                        {
                            "description": item["description"],
                            "cost": item["cost"],
                            "date": item.get("date"),
                        }
                    )

    return adjustments


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=True)
