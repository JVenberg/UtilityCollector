"""
Cloud Run Scraper Service

This service handles all Playwright-based scraping for:
- Seattle Utilities (bills)
- NextCentury Meters (readings)

It's triggered by Cloud Scheduler and writes results to Firestore.
"""

import logging
import os

from firebase_admin import credentials, firestore, initialize_app, storage
from flask import Flask, jsonify, request

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
from scrapers.nextcentury_meters import NextCenturyError, NextCenturyMetersScraper

# Import scrapers
from scrapers.seattle_utilities import SeattleUtilitiesScraper

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)


@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint."""
    return jsonify({"status": "healthy"})


@app.route("/debug/login", methods=["POST"])
def debug_login():
    """
    Debug endpoint to test NextCentury login and token extraction.
    Returns detailed debugging info.
    """
    import time

    from playwright.sync_api import sync_playwright

    try:
        # Get credentials from Firestore
        creds = get_utility_credentials()

        if not creds:
            return jsonify({"error": "No credentials found in Firestore"}), 400

        username = creds.get("nextcentury_username")
        password = creds.get("nextcentury_password")
        property_id = creds.get("nextcentury_property_id")

        debug_info = {
            "credentials": {
                "username": username,
                "password_length": len(password) if password else 0,
                "password_first_char": (
                    password[0] if password and len(password) > 0 else None
                ),
                "password_last_char": (
                    password[-1] if password and len(password) > 0 else None
                ),
                "property_id": property_id,
            },
            "steps": [],
            "localStorage_checks": [],
            "final_state": {},
        }

        if not username or not password:
            debug_info["error"] = "Missing username or password"
            return jsonify(debug_info), 400

        # Start browser
        debug_info["steps"].append("Starting Playwright...")
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context()
            page = context.new_page()

            debug_info["steps"].append("Navigating to NextCentury...")
            page.goto("https://app.nextcenturymeters.com", timeout=30000)

            try:
                page.wait_for_load_state("networkidle", timeout=25000)
                debug_info["steps"].append("Page loaded (networkidle)")
            except Exception as e:
                debug_info["steps"].append(f"networkidle timeout: {e}")

            # Wait for the page to fully render (SPA apps need time)
            debug_info["steps"].append("Waiting for page to render...")
            time.sleep(3)

            # Try different selectors for password field
            password_selectors = [
                'input[type="password"]',
                'input[name="password"]',
                'input[placeholder*="assword"]',
                "#password",
            ]

            password_field = None
            for selector in password_selectors:
                count = page.locator(selector).count()
                debug_info["steps"].append(f"Selector '{selector}': {count} elements")
                if count > 0:
                    password_field = page.locator(selector).first
                    break

            has_password_field = password_field is not None
            debug_info["steps"].append(f"Password field found: {has_password_field}")

            # Take screenshot for debugging
            import base64

            screenshot_bytes = page.screenshot()
            debug_info["screenshot_base64"] = base64.b64encode(screenshot_bytes).decode(
                "utf-8"
            )

            if has_password_field:
                debug_info["steps"].append("Filling login form...")

                # Fill email
                email_input = page.locator('input[type="email"]')
                if email_input.count() == 0:
                    email_input = page.locator("input").first
                email_input.fill(username)

                # Fill password
                password_field.fill(password)

                # Submit
                debug_info["steps"].append("Clicking submit...")
                page.locator('button[type="submit"]').click()

                # Wait for dashboard
                try:
                    page.wait_for_selector("text=Dashboard", timeout=15000)
                    debug_info["steps"].append("Dashboard loaded!")
                except Exception as e:
                    debug_info["steps"].append(f"Dashboard not found: {e}")
                    # Try Enter key
                    try:
                        page.locator('input[type="password"]').press("Enter")
                        page.wait_for_selector("text=Dashboard", timeout=15000)
                        debug_info["steps"].append("Dashboard loaded after Enter!")
                    except Exception as e2:
                        debug_info["steps"].append(f"Still failed: {e2}")

            # Check localStorage over time
            for i in range(10):
                time.sleep(1)

                all_keys = page.evaluate(
                    """
                    () => {
                        const keys = [];
                        for (let i = 0; i < localStorage.length; i++) {
                            keys.push(localStorage.key(i));
                        }
                        return keys;
                    }
                """
                )

                token = page.evaluate("() => localStorage.getItem('token')")

                debug_info["localStorage_checks"].append(
                    {
                        "second": i + 1,
                        "keys": all_keys,
                        "has_token": bool(token),
                        "token_length": len(token) if token else 0,
                    }
                )

                if token:
                    debug_info["final_state"]["token_found"] = True
                    debug_info["final_state"]["token_prefix"] = (
                        token[:50] if token else None
                    )
                    break

            # Get final state
            debug_info["final_state"]["url"] = page.url
            debug_info["final_state"]["title"] = page.title()

            browser.close()

        return jsonify(debug_info)

    except Exception as e:
        log.error(f"Debug login error: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500


@app.route("/readings", methods=["POST"])
def get_readings():
    """
    Fetch meter readings for a specific date range.

    Request body:
    {
        "start_date": "Dec 01, 2024" or "12/01/2024",
        "end_date": "Dec 31, 2024" or "12/31/2024"
    }

    Returns readings in gallons (primary) with CCF conversion.
    """
    try:
        data = request.get_json() or {}
        start_date = data.get("start_date")
        end_date = data.get("end_date")

        # Get credentials from Firestore
        creds = get_utility_credentials()

        if not creds:
            return (
                jsonify(
                    {
                        "success": False,
                        "error": "Missing credentials - please configure in Settings",
                    }
                ),
                400,
            )

        username = creds.get("nextcentury_username")
        password = creds.get("nextcentury_password")
        property_id = creds.get("nextcentury_property_id")

        if not username:
            return (
                jsonify(
                    {
                        "success": False,
                        "error": "Missing NextCentury username in Settings",
                    }
                ),
                400,
            )
        if not password:
            return (
                jsonify(
                    {
                        "success": False,
                        "error": "Missing NextCentury password in Settings",
                    }
                ),
                400,
            )
        if not property_id:
            return (
                jsonify(
                    {
                        "success": False,
                        "error": "Missing NextCentury property_id in Settings",
                    }
                ),
                400,
            )

        scraper = NextCenturyMetersScraper(username, password, property_id)

        try:
            if start_date and end_date:
                readings, warnings = scraper.get_readings_for_bill_period(
                    start_date, end_date
                )
            else:
                # Default to last 60 days
                readings, warnings = scraper.get_current_readings(60)

            # Check if we got any readings
            if not readings:
                error_msg = "No readings returned from NextCentury."
                if warnings:
                    error_msg += f" Details: {'; '.join(warnings)}"
                return jsonify({"success": False, "error": error_msg}), 400

            # Store readings in Firestore
            db.collection("settings").document("latest_readings").set(
                {
                    "readings": readings,
                    "fetched_at": firestore.SERVER_TIMESTAMP,
                    "period": (
                        {
                            "start_date": start_date,
                            "end_date": end_date,
                        }
                        if start_date and end_date
                        else None
                    ),
                }
            )

            response_data = {
                "success": True,
                "readings": readings,
                "unit": "gallons",
            }
            if warnings:
                response_data["warnings"] = warnings

            return jsonify(response_data)
        finally:
            scraper.close()

    except NextCenturyError as e:
        log.error(f"NextCentury error: {e}")
        return jsonify({"success": False, "error": str(e)}), 400
    except Exception as e:
        log.error(f"Error fetching readings: {e}", exc_info=True)
        return jsonify({"success": False, "error": f"Unexpected error: {str(e)}"}), 500


@app.route("/scrape", methods=["POST"])
def scrape():
    """
    Main scraping endpoint. Dispatches to the appropriate scraper based on type.

    Request body:
    {
        "type": "seattle_utilities" | "nextcentury_meters" | "all",
        "community_id": "optional-community-id",
        "force_update": false  # If true, re-parse existing bills
    }
    """
    try:
        data = request.get_json() or {}
        scrape_type = data.get("type", "all")
        community_id = data.get("community_id")
        force_update = data.get("force_update", False)

        results = {
            "success": True,
            "seattle_utilities": None,
            "nextcentury_meters": None,
        }

        if scrape_type in ["seattle_utilities", "all"]:
            results["seattle_utilities"] = scrape_seattle_utilities(force_update=force_update)

        if scrape_type in ["nextcentury_meters", "all"]:
            results["nextcentury_meters"] = scrape_nextcentury_meters()

        return jsonify(results)

    except Exception as e:
        log.error(f"Scraping error: {e}", exc_info=True)
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/refresh-bill", methods=["POST"])
def refresh_bill():
    """
    Re-parse and update an existing bill's parsed_data.
    
    This is useful when the parser has been updated and we need to
    refresh the parsed_data for existing bills without re-downloading.
    
    Request body:
    {
        "bill_id": "firestore-bill-id"
    }
    """
    try:
        data = request.get_json() or {}
        bill_id = data.get("bill_id")
        
        if not bill_id:
            return jsonify({"success": False, "error": "Missing bill_id"}), 400
        
        # Get the bill from Firestore
        bill_doc = db.collection("bills").document(bill_id).get()
        if not bill_doc.exists:
            return jsonify({"success": False, "error": f"Bill {bill_id} not found"}), 404
        
        bill_data = bill_doc.to_dict()
        pdf_url = bill_data.get("pdf_url", "")
        
        if not pdf_url:
            return jsonify({"success": False, "error": "Bill has no PDF URL"}), 400
        
        # Download PDF from Cloud Storage
        import tempfile
        from pathlib import Path
        
        # Extract blob name from gs:// URL
        # Format: gs://bucket-name/bills/date.pdf
        blob_name = pdf_url.replace(f"gs://{bucket.name}/", "")
        blob = bucket.blob(blob_name)
        
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp_file:
            blob.download_to_filename(tmp_file.name)
            pdf_path = Path(tmp_file.name)
        
        try:
            # Parse the bill with updated parser
            parser = BillParser()
            parsed_data = parser.parse(str(pdf_path))
            
            # Update the bill in Firestore
            db.collection("bills").document(bill_id).update({
                "services": parsed_data["services"],  # Flattened - no more parsed_data wrapper
                "due_date": parsed_data["due_date"],
                "total_amount": parsed_data["total"],
            })
            
            # Check for adjustments and update them
            has_adjustments = any(
                "adjustment" in service.lower()
                for service in parsed_data.get("services", {}).keys()
            )
            
            if has_adjustments:
                # Clear existing adjustments and re-add
                adjustments_ref = db.collection("bills").document(bill_id).collection("adjustments")
                for adj_doc in adjustments_ref.stream():
                    adj_doc.reference.delete()
                
                adjustments = extract_adjustments(parsed_data)
                for adj in adjustments:
                    adjustments_ref.add({
                        "description": adj["description"],
                        "cost": adj["cost"],
                        "date": adj.get("date"),
                        "assigned_unit_ids": [],
                    })
            
            log.info(f"Successfully refreshed bill {bill_id}")
            
            return jsonify({
                "success": True,
                "bill_id": bill_id,
                "services": parsed_data["services"],
                "due_date": parsed_data["due_date"],
                "total_amount": parsed_data["total"],
            })
            
        finally:
            # Clean up temp file
            pdf_path.unlink()
    
    except Exception as e:
        log.error(f"Error refreshing bill: {e}", exc_info=True)
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


def scrape_seattle_utilities(force_update: bool = False):
    """Scrape Seattle Utilities for new bills.
    
    Args:
        force_update: If True, re-parse and update existing bills instead of skipping them.
    """
    log.info(f"Starting Seattle Utilities scrape... (force_update={force_update})")

    # Get credentials from Firestore
    creds = get_utility_credentials()

    if not creds:
        log.error("No utility credentials found in Firestore")
        return {
            "error": "Missing credentials - please configure in Settings",
            "new_bills": [],
            "updated_bills": [],
        }

    username = creds.get("seattle_utilities_username")
    password = creds.get("seattle_utilities_password")
    account = creds.get("seattle_utilities_account", "4553370429")

    if not username or not password:
        log.error("Missing Seattle Utilities credentials in Firestore")
        return {
            "error": "Missing Seattle Utilities credentials - please configure in Settings",
            "new_bills": [],
            "updated_bills": [],
        }

    scraper = SeattleUtilitiesScraper(username, password, account)
    parser = BillParser()

    # Track bills that need readings auto-populated (after Seattle scraper closes)
    bills_needing_readings = []
    new_bills = []
    updated_bills = []
    total_checked = 0

    try:
        # Check for available bills
        bills = scraper.check_for_new_bills()
        total_checked = len(bills)

        for bill_info in bills:
            # Convert bill date to ISO format for document ID (e.g., "12/08/2024" -> "2024-12-08")
            # This ensures bills sort chronologically in Firebase console
            date_parts = bill_info["date"].split("/")  # MM/DD/YYYY
            bill_id = f"{date_parts[2]}-{date_parts[0]}-{date_parts[1]}"  # YYYY-MM-DD
            
            # Check if already exists in Firestore
            existing_doc = db.collection("bills").document(bill_id).get()

            if existing_doc.exists and not force_update:
                log.info(f"Bill {bill_info['date']} already exists, skipping")
                continue
            
            if existing_doc.exists and force_update:
                # Update existing bill
                log.info(f"Updating existing bill: {bill_info['date']}")
                
                # Download and re-parse
                pdf_path = scraper.download_bill(bill_info["date"])
                parsed_data = parser.parse(str(pdf_path))
                
                # Update the document
                db.collection("bills").document(bill_id).update({
                    "services": parsed_data["services"],  # Flattened - no more parsed_data wrapper
                    "due_date": parsed_data["due_date"],
                    "total_amount": parsed_data["total"],
                })
                
                # Re-extract adjustments
                has_adjustments = any(
                    "adjustment" in service.lower()
                    for service in parsed_data.get("services", {}).keys()
                )
                
                if has_adjustments:
                    # Clear existing adjustments and re-add
                    adjustments_ref = db.collection("bills").document(bill_id).collection("adjustments")
                    for adj_doc in adjustments_ref.stream():
                        adj_doc.reference.delete()
                    
                    adjustments = extract_adjustments(parsed_data)
                    for adj in adjustments:
                        adjustments_ref.add({
                            "description": adj["description"],
                            "cost": adj["cost"],
                            "date": adj.get("date"),
                            "assigned_unit_ids": [],
                        })
                
                updated_bills.append({
                    "id": bill_id,
                    "date": bill_info["date"],
                    "amount": bill_info["amount"],
                })
                
                log.info(f"Successfully updated bill {bill_info['date']}")
                pdf_path.unlink()
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

            # Create Firestore document with bill date as ID
            bill_ref = db.collection("bills").document(bill_id)
            bill_data = {
                "bill_date": bill_info["date"],
                "due_date": parsed_data["due_date"],
                "total_amount": parsed_data["total"],
                "pdf_url": pdf_url,
                "status": "NEEDS_REVIEW" if has_adjustments else "NEW",
                "has_adjustments": has_adjustments,
                "services": parsed_data["services"],  # Flattened - no more parsed_data wrapper
                "created_at": firestore.SERVER_TIMESTAMP,
                "approved_at": None,
                "approved_by": None,
            }
            bill_ref.set(bill_data)

            # Extract and save adjustments as subcollection
            adjustments = extract_adjustments(parsed_data)
            for adj in adjustments:
                db.collection("bills").document(bill_id).collection(
                    "adjustments"
                ).add(
                    {
                        "description": adj["description"],
                        "cost": adj["cost"],
                        "date": adj.get("date"),
                        "assigned_unit_ids": [],
                    }
                )

            # Queue this bill for readings auto-population (done after scraper closes)
            bills_needing_readings.append({
                "bill_id": bill_id,
                "parsed_data": parsed_data,
                "bill_info": bill_info,
            })

            log.info(f"Successfully saved bill {bill_info['date']}")

            # Clean up temp file
            pdf_path.unlink()

    finally:
        scraper.close()
        log.info("Seattle Utilities scraper closed")

    # Trigger async readings fetch for each new bill by calling Cloud Function
    # This uses fire-and-forget HTTP calls so each bill is processed independently
    import requests
    
    # Cloud Function URL for populateBillReadings
    cloud_function_url = "https://us-central1-utilitysplitter.cloudfunctions.net/populateBillReadings"
    
    # Get the shared secret for authenticating to Cloud Function
    scraper_secret = os.environ.get("SCRAPER_SECRET", "")
    if not scraper_secret:
        log.warning("SCRAPER_SECRET not configured - Cloud Function calls will fail auth")
    
    headers = {
        "Content-Type": "application/json",
        "X-Scraper-Secret": scraper_secret,
    }
    
    for bill_data in bills_needing_readings:
        bill_id = bill_data["bill_id"]
        parsed_data = bill_data["parsed_data"]
        bill_info = bill_data["bill_info"]
        
        # Get date range from water service
        water_service = parsed_data.get("services", {}).get("Water Service")
        if water_service and water_service.get("parts"):
            first_part = water_service["parts"][0]
            start_date = first_part.get("start_date")
            end_date = first_part.get("end_date")
            
            if start_date and end_date:
                # Fire-and-forget HTTP call to Cloud Function
                # Cloud Function will call scraper /readings and save to Firestore
                try:
                    log.info(f"Triggering Cloud Function for bill {bill_id}: {start_date} to {end_date}")
                    requests.post(
                        cloud_function_url,
                        headers=headers,
                        json={
                            "billId": bill_id,
                            "startDate": start_date,
                            "endDate": end_date,
                        },
                        timeout=1,  # Fire and forget - don't wait for response
                    )
                except requests.exceptions.Timeout:
                    # Expected - we don't wait for response
                    log.info(f"Fire-and-forget request sent for bill {bill_id}")
                except Exception as e:
                    log.warning(f"Error triggering Cloud Function for {bill_id}: {e}")
        
        new_bills.append({
            "id": bill_id,
            "date": bill_info["date"],
            "amount": bill_info["amount"],
        })
    
    log.info(f"Triggered Cloud Function for {len(bills_needing_readings)} new bills")

    return {"new_bills": new_bills, "updated_bills": updated_bills, "total_checked": total_checked}


def scrape_nextcentury_meters():
    """Scrape NextCentury Meters for current readings (in gallons)."""
    log.info("Starting NextCentury Meters scrape...")

    # Get credentials from Firestore
    creds = get_utility_credentials()

    if not creds:
        log.warning("No utility credentials found in Firestore")
        return {
            "error": "Missing credentials - please configure in Settings",
            "readings": {},
        }

    username = creds.get("nextcentury_username")
    password = creds.get("nextcentury_password")
    property_id = creds.get("nextcentury_property_id")

    if not username:
        log.warning("Missing NextCentury username, skipping")
        return {"error": "Missing NextCentury username in Settings", "readings": {}}

    if not password:
        log.warning("Missing NextCentury password, skipping")
        return {"error": "Missing NextCentury password in Settings", "readings": {}}

    if not property_id:
        log.warning("Missing NextCentury property_id, skipping")
        return {"error": "Missing NextCentury property_id in Settings", "readings": {}}

    scraper = NextCenturyMetersScraper(username, password, property_id)

    try:
        # Get current readings (last 60 days) - returns gallons with CCF conversion
        readings, warnings = scraper.get_current_readings(60)

        # Store readings in settings for quick access
        # Format: {unit_name: {gallons: int, ccf: float, start_date: str, end_date: str}}
        if readings:
            db.collection("settings").document("latest_readings").set(
                {
                    "readings": readings,
                    "fetched_at": firestore.SERVER_TIMESTAMP,
                    "unit": "gallons",
                }
            )
            log.info(f"Stored readings for {len(readings)} units (in gallons)")

        result = {"readings": readings, "unit": "gallons"}
        if warnings:
            result["warnings"] = warnings
        return result

    except NextCenturyError as e:
        log.error(f"NextCentury error: {e}")
        return {"error": str(e), "readings": {}}

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
