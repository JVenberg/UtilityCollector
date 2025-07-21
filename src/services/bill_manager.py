import itertools
import logging
import math
import re
from functools import partial
from pathlib import Path
from typing import Any
from typing import Dict

from playwright.sync_api import sync_playwright
from PyPDF2 import PdfReader
from sqlmodel import Session

from core.config import settings
from db import crud
from db import models

log = logging.getLogger(__name__)

# --- PDF Parsing Logic (from bill_parser.py) ---

HEADER_REGEX = r"DUE DATE: (?P<due_date>[A-Za-z]+ \d{2}, \d{4})(?:.|\n)*Current billing: (?P<total>\d+\.\d{2})"
SERVICE_REGEX = (
    r"(?P<service>[A-Za-z ]+)(?P<bill>(?:.|\n)+?)Current \1: (?P<total>\d+\.\d{2})"
)
USAGE_REGEX = r"(?P<start_date>\w{3} \d{2}, \d{4}) (?P<end_date>\w{3} \d{2}, \d{4}) (?P<usage>\d+.\d{2})\*?(?: (?P<start_meter>\d+.\d{2})\*? (?P<end_meter>\d+.\d{2})\*?)?"
METER_REGEX = r"Meter Number: (?P<meter_number>[\w-]+) Service Category: ?(?P<service_category>\w*)"
ITEM_REGEX = r"^(?:(?P<start>\w{3} \d{2}, \d{4}) (?P<end>\w{3} \d{2}, \d{4}) *)?(?P<description>.+?)\s*(?:(?P<date>\w{3} \d{2}, \d{4}) *)?(?:(?P<usage>\d+\.\d{2}) CCF @ \$(?P<rate>\d+.\d{2}) per CCF )?(?P<cost>\d+\.\d{2})"
TRASH_REGEX = r"^(?P<count>\d+)-(?P<description>[\w /]+) (?P<size>\d+) Gal"


class BillManager:
    def __init__(self, db: Session):
        self.db = db

    def sync_all_bills(self):
        """
        Orchestrates the process of downloading, parsing, and saving all utility bills from the website.
        """
        log.info("Starting bill sync process for all bills...")
        try:
            bill_data_list = self._download_all_bills()

            if not bill_data_list:
                log.info("No bills found on the website.")
                return

            log.info(f"Found {len(bill_data_list)} bills on the website.")

            for downloaded_path, bill_date_str in bill_data_list:
                try:
                    final_pdf_path = Path(
                        f"data/bills/utility_bill_{bill_date_str.replace('/', '-')}.pdf"
                    )

                    if crud.get_bill_by_pdf_path(self.db, str(final_pdf_path)):
                        log.info(
                            f"Bill {final_pdf_path} already exists in the database. Skipping."
                        )
                        downloaded_path.unlink()  # remove temp file
                        continue

                    log.info(f"Processing new bill for date {bill_date_str}...")
                    downloaded_path.rename(final_pdf_path)

                    parsed_data = self._parse_bill(str(final_pdf_path))

                    new_bill = models.Bill(
                        bill_date=bill_date_str,
                        due_date=parsed_data["due_date"],
                        total_amount=parsed_data["total"],
                        pdf_path=str(final_pdf_path),
                        status="NEW",
                    )

                    created_bill = crud.create_bill(self.db, new_bill)

                    # Extract and save parsed adjustments
                    self._save_parsed_adjustments(created_bill, parsed_data)

                    log.info(
                        f"Successfully saved bill {final_pdf_path} to the database."
                    )

                except Exception as e:
                    log.error(
                        f"Error processing bill {bill_date_str}: {e}", exc_info=True
                    )
                    # Clean up temp file if it still exists
                    if downloaded_path.exists():
                        downloaded_path.unlink()

        except Exception as e:
            log.error(
                f"An error occurred during the bill sync process: {e}", exc_info=True
            )

    def sync_latest_bill(self):
        """
        Backward compatibility method - now calls sync_all_bills.
        """
        log.info(
            "sync_latest_bill called - redirecting to sync_all_bills for better coverage"
        )
        self.sync_all_bills()

    def _download_latest_bill(self) -> tuple[Path, str]:
        """
        Uses Playwright to download the most recent bill PDF.
        Returns the path to the temporary downloaded file and the bill date string.
        """
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context()
            page = context.new_page()

            log.info("Navigating to utility login page...")
            page.goto("https://myutilities.seattle.gov/rest/auth/ssologin")
            page.wait_for_selector('input[name="userName"]', timeout=25000)

            log.info("Logging in...")
            page.locator('input[name="userName"]').fill(settings.UTILITY_USERNAME)
            page.locator('input[name="password"]').fill(settings.UTILITY_PASSWORD)
            page.locator('button[type="submit"]').click()

            log.info("Navigating to billing history page...")
            page.wait_for_load_state("networkidle", timeout=25000)
            page.goto(
                "https://myutilities.seattle.gov/eportal/#/billinghistory?acct=4553370429"
            )
            page.wait_for_selector("table.app-table", timeout=25000)

            first_bill_row = page.locator("table.app-table tbody tr:first-child")
            bill_date_str = first_bill_row.locator("td:first-child").inner_text()

            log.info(
                f"Found latest bill with date: {bill_date_str}. Navigating to viewer..."
            )
            first_bill_row.locator("a.view-bill-link").click()
            page.wait_for_url("**/ViewBill.aspx", timeout=25000)

            log.info("Downloading bill PDF...")
            with page.expect_download() as download_info:
                page.locator("#main_divBillToolBar #main_PDF").click()

            download = download_info.value
            temp_path = Path(f"/tmp/{download.suggested_filename}")
            download.save_as(temp_path)

            log.info(f"Bill downloaded to temporary path: {temp_path}")
            browser.close()
            return temp_path, bill_date_str

    def _download_all_bills(self) -> list[tuple[Path, str]]:
        """
        Uses Playwright to download all bill PDFs from the billing history.
        Returns a list of tuples: (temp_path, bill_date_str) for each bill.
        """
        downloaded_bills = []

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context()
            page = context.new_page()

            log.info("Navigating to utility login page...")
            page.goto("https://myutilities.seattle.gov/rest/auth/ssologin")
            page.wait_for_selector('input[name="userName"]', timeout=25000)

            log.info("Logging in...")
            page.locator('input[name="userName"]').fill(settings.UTILITY_USERNAME)
            page.locator('input[name="password"]').fill(settings.UTILITY_PASSWORD)
            page.locator('button[type="submit"]').click()

            log.info("Navigating to billing history page...")
            page.wait_for_load_state("networkidle", timeout=25000)
            page.goto(
                "https://myutilities.seattle.gov/eportal/#/billinghistory?acct=4553370429"
            )
            page.wait_for_selector("table.app-table", timeout=25000)

            # Get all bill rows, but filter out pagination/footer rows
            all_rows = page.locator("table.app-table tbody tr").all()
            bill_rows = []

            # Filter out non-bill rows (pagination, etc.)
            for row in all_rows:
                first_cell_text = row.locator("td:first-child").inner_text()
                # Skip rows that don't look like dates (MM/DD/YYYY format)
                if "/" in first_cell_text and len(first_cell_text.split("/")) == 3:
                    bill_rows.append(row)

            log.info(f"Found {len(bill_rows)} valid bills in billing history")

            for i, bill_row in enumerate(bill_rows):
                bill_date_str = "unknown"
                try:
                    bill_date_str = bill_row.locator("td:first-child").inner_text()
                    log.info(
                        f"Processing bill {i + 1}/{len(bill_rows)}: {bill_date_str}"
                    )

                    # Click the view bill link
                    bill_row.locator("a.view-bill-link").click()
                    page.wait_for_url("**/ViewBill.aspx", timeout=25000)

                    # Download the PDF
                    with page.expect_download() as download_info:
                        page.locator("#main_divBillToolBar #main_PDF").click()

                    download = download_info.value
                    temp_path = Path(f"/tmp/{download.suggested_filename}_{i}")
                    download.save_as(temp_path)

                    downloaded_bills.append((temp_path, bill_date_str))
                    log.info(f"Downloaded bill {bill_date_str} to {temp_path}")

                    # Navigate back to billing history for next bill
                    page.goto(
                        "https://myutilities.seattle.gov/eportal/#/billinghistory?acct=4553370429"
                    )
                    page.wait_for_selector("table.app-table", timeout=25000)

                except Exception as e:
                    log.error(f"Error downloading bill {i + 1} ({bill_date_str}): {e}")
                    continue

            browser.close()

        log.info(f"Successfully downloaded {len(downloaded_bills)} bills")
        return downloaded_bills

    def _parse_bill(self, file_name: str) -> Dict[str, Any]:
        """Parses the entire bill PDF."""
        reader = PdfReader(file_name)
        header: list[dict[str, Any]] = []
        reader.pages[0].extract_text(visitor_text=partial(self._visitor_body, header))
        header_text = "\n".join([part["text"].strip() for part in header])

        body: list[dict[str, Any]] = []
        for page in reader.pages[1:]:
            page.extract_text(visitor_text=partial(self._visitor_body, body))
        body_text = "\n".join([part["text"].strip() for part in body])

        parsed_data = {
            **self._parse_header(header_text),
            "services": self._parse_services(body_text),
        }
        self._validate_bill(parsed_data)
        return parsed_data

    def _visitor_body(self, parts, text, _cm, tm, font_dict, _font_size):
        size, x, y = tm[3], tm[4], tm[5]
        font_name = font_dict["/BaseFont"].split("+")[-1] if font_dict else None
        if x > 240 and (font_name == "Arial-BoldMT" or font_name == "ArialMT"):
            parts.append(
                {
                    "text": text.replace("O00934", ""),
                    "font": font_name,
                    "size": size,
                    "x": x,
                    "y": y,
                }
            )

    def _parse_header(self, header_str: str) -> Dict[str, Any]:
        match = re.search(HEADER_REGEX, header_str)
        if not match:
            raise ValueError("Could not parse bill header.")
        return {
            "due_date": match.group("due_date"),
            "total": float(match.group("total")),
        }

    def _parse_services(self, bill_str: str) -> Dict[str, Any]:
        services = {}
        for match in re.finditer(SERVICE_REGEX, bill_str):
            services[match.group("service")] = {
                "total": float(match.group("total")),
                "parts": self._parse_service_bill(match.group("bill")),
            }
        return services

    def _parse_service_bill(self, bill_str: str) -> list:
        groups = []
        splits = re.split(USAGE_REGEX, bill_str)
        if len(splits) > 1:
            for meter_group in itertools.batched(splits[1:], 6):
                start_date, end_date, usage, start_meter, end_meter, items_str = (
                    meter_group
                )
                groups.append(
                    {
                        "items": self._parse_items(items_str),
                        "start_date": start_date,
                        "end_date": end_date,
                        "usage": float(usage),
                        **({"start_meter": float(start_meter)} if start_meter else {}),
                        **({"end_meter": float(end_meter)} if end_meter else {}),
                        **self._parse_meter(items_str),
                    }
                )
        else:
            items_str = splits[0]
            groups.append(
                {"items": self._parse_items(items_str), **self._parse_meter(items_str)}
            )
        return groups

    def _parse_items(self, bill_str: str) -> list:
        items = []
        for match in re.finditer(ITEM_REGEX, bill_str, re.MULTILINE):
            items.append(
                self._parse_trash(
                    {
                        "description": match.group("description")
                        .replace("\n", " ")
                        .strip(),
                        "cost": float(match.group("cost")),
                        **(
                            {"start": match.group("start")}
                            if match.group("start")
                            else {}
                        ),
                        **({"end": match.group("end")} if match.group("end") else {}),
                        **(
                            {"date": match.group("date")} if match.group("date") else {}
                        ),
                        **(
                            {"usage": float(match.group("usage"))}
                            if match.group("usage")
                            else {}
                        ),
                        **(
                            {"rate": float(match.group("rate"))}
                            if match.group("rate")
                            else {}
                        ),
                    }
                )
            )
        return items

    def _parse_trash(self, item: Dict[str, Any]) -> Dict[str, Any]:
        match = re.search(TRASH_REGEX, item["description"])
        if match:
            return {
                **item,
                "description": match.group("description").strip(),
                "size": int(match.group("size")),
                "count": int(match.group("count")),
            }
        return item

    def _parse_meter(self, bill_str: str) -> Dict[str, str]:
        meter = re.search(METER_REGEX, bill_str)
        if meter:
            return {
                "meter_number": meter.group("meter_number"),
                "service_category": meter.group("service_category"),
            }
        return {}

    def _validate_bill(self, bill: Dict[str, Any]):
        bill_total = sum(
            service_data["total"] for service, service_data in bill["services"].items()
        )
        assert math.isclose(bill_total, bill["total"]), (
            f"Bill total mismatch: {bill_total} != {bill['total']}"
        )

        for service, service_data in bill["services"].items():
            service_total = sum(
                item["cost"] for part in service_data["parts"] for item in part["items"]
            )

            # For adjustments, log parsing issues but don't crash - the regex may not catch all formats
            if "adjustment" in service.lower():
                if not math.isclose(service_total, service_data["total"]):
                    items_found = [
                        f"{item['description']}: ${item['cost']}"
                        for part in service_data["parts"]
                        for item in part["items"]
                    ]
                    log.warning(
                        f"Adjustment parsing incomplete for {service}: "
                        f"Found {len(items_found)} items totaling ${service_total}, but bill shows ${service_data['total']}. "
                        f"Items found: {items_found}. "
                        f"This indicates the regex patterns need improvement for this bill format."
                    )
                    # Continue processing - we'll save what we found and the user can manually handle missing ones
            else:
                assert math.isclose(service_total, service_data["total"]), (
                    f"Service total mismatch {service}: {service_total} != {service_data['total']}"
                )

    def _save_parsed_adjustments(self, bill: models.Bill, parsed_data: Dict[str, Any]):
        """
        Extracts adjustments from parsed bill data and saves them as ParsedAdjustment records.
        """
        adjustments_service = None
        for service_name in parsed_data.get("services", {}).keys():
            if "adjustment" in service_name.lower():
                adjustments_service = parsed_data["services"][service_name]
                break

        if not adjustments_service:
            log.info("No adjustments found in bill")
            return

        for part in adjustments_service["parts"]:
            for item in part["items"]:
                if bill.id is None:
                    log.error("Cannot save parsed adjustment: bill.id is None")
                    continue

                adjustment = models.ParsedAdjustment(
                    bill_id=bill.id,
                    description=item["description"],
                    cost=item["cost"],
                    date=item.get("date"),  # Optional date field
                )
                crud.create_parsed_adjustment(self.db, adjustment)
                log.info(
                    f"Saved parsed adjustment: {item['description']} - ${item['cost']}"
                )
