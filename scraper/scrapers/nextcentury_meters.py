"""
NextCentury Meters Scraper

Uses Playwright to login and extract JWT token, then calls the NextCentury API
directly to get meter readings. This is more reliable than scraping the UI.
"""

import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

from playwright.sync_api import Browser, BrowserContext, Page, sync_playwright

log = logging.getLogger(__name__)


class NextCenturyError(Exception):
    """Exception raised when NextCentury scraping fails."""

    pass


@dataclass
class UnitReading:
    """Represents a meter reading for a unit."""

    unit_id: str
    unit_name: str
    usage_gallons: int
    usage_ccf: float
    meter_read: int


class NextCenturyMetersScraper:
    """
    Scrapes meter readings from NextCentury Meters using their REST API.

    The approach:
    1. Login via browser to establish session and get JWT token from localStorage
    2. Use the JWT token to call the API directly for data

    Usage:
        scraper = NextCenturyMetersScraper(username, password, property_id)
        try:
            readings = scraper.get_readings_for_period(start_date, end_date)
        finally:
            scraper.close()
    """

    BASE_URL = "https://app.nextcenturymeters.com"
    API_URL = "https://api.nextcenturymeters.com/api"

    def __init__(self, username: str, password: str, property_id: str):
        """
        Initialize the scraper.

        Args:
            username: NextCentury login username/email
            password: NextCentury login password
            property_id: Property ID (e.g., "p_25098")
        """
        self.username = username
        self.password = password
        self.property_id = property_id

        self._playwright = None
        self._browser: Optional[Browser] = None
        self._context: Optional[BrowserContext] = None
        self._page: Optional[Page] = None
        self._auth_token: Optional[str] = None

    def _ensure_browser(self):
        """Ensure browser is initialized."""
        if self._browser is None:
            self._playwright = sync_playwright().start()
            self._browser = self._playwright.chromium.launch(headless=True)
            self._context = self._browser.new_context()
            self._page = self._context.new_page()

    def _login(self):
        """Log into NextCentury website and extract JWT token."""
        if self._auth_token:
            return

        self._ensure_browser()
        assert self._page is not None

        log.info("Navigating to NextCentury...")
        try:
            self._page.goto(self.BASE_URL, timeout=30000)
        except Exception as e:
            raise NextCenturyError(f"Failed to connect to NextCentury website: {e}")

        try:
            self._page.wait_for_load_state("networkidle", timeout=25000)
        except Exception as e:
            log.warning(f"Timeout waiting for network idle: {e}")
            # Continue anyway, page might be loaded enough

        # Wait for the login form to appear - NextCentury is a SPA that renders dynamically
        log.info("Waiting for login form to render...")
        try:
            self._page.wait_for_selector('input[type="password"]', timeout=15000)
            log.info("Login form found, logging in...")

            # Fill email - wait for it to be ready too
            email_input = self._page.locator('input[type="email"]')
            if email_input.count() == 0:
                email_input = self._page.locator("input").first
            email_input.fill(self.username)

            # Fill password
            self._page.locator('input[type="password"]').fill(self.password)

            # Submit
            self._page.locator('button[type="submit"]').click()

            # Wait for dashboard to load
            try:
                self._page.wait_for_selector("text=Dashboard", timeout=15000)
                log.info("Login successful!")
            except Exception:
                # Try Enter key as fallback
                try:
                    self._page.locator('input[type="password"]').press("Enter")
                    self._page.wait_for_selector("text=Dashboard", timeout=15000)
                    log.info("Login successful!")
                except Exception as e:
                    # Check for error messages on page
                    error_text = ""
                    try:
                        # Common error selectors
                        error_elem = self._page.locator(
                            '.error, .alert-danger, [class*="error"], [class*="Error"]'
                        ).first
                        if error_elem.count() > 0:
                            error_text = error_elem.inner_text()
                    except:
                        pass

                    if error_text:
                        raise NextCenturyError(f"Login failed: {error_text}")
                    else:
                        raise NextCenturyError(
                            f"Login failed - could not reach Dashboard. Check username/password. Details: {e}"
                        )
        except Exception as e:
            # No login form found - might already be logged in, or page failed to load
            log.warning(f"No login form found or timeout: {e}")

        # Wait for the app to store the token in localStorage
        log.info("Waiting for auth token...")

        # Extract token from localStorage with retry (token may take a moment to be stored)
        token = None
        for attempt in range(5):
            token = self._page.evaluate("() => localStorage.getItem('token')")
            if token:
                log.info(f"Token found on attempt {attempt + 1}")
                break
            log.warning(f"Token not found on attempt {attempt + 1}, waiting...")
            time.sleep(1)

        if not token:
            # Debug: list all localStorage keys
            all_keys = self._page.evaluate(
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
            log.error(f"No token found after retries. localStorage keys: {all_keys}")
            raise NextCenturyError(
                f"Login appeared successful but no auth token found after 5 retries. localStorage keys: {all_keys}"
            )

        self._auth_token = token
        log.info("Auth token extracted successfully")

    def _get_units(self) -> List[dict]:
        """Get all units for the property."""
        self._login()
        assert self._page is not None
        assert self._auth_token is not None

        headers: Dict[str, str] = {"Authorization": self._auth_token}
        url = f"{self.API_URL}/Properties/{self.property_id}/Units"

        log.info(f"Fetching units from: {url}")

        response = self._page.request.get(url, headers=headers)
        if not response.ok:
            if response.status == 401:
                raise NextCenturyError(
                    "Authentication expired or invalid. Please re-check credentials."
                )
            elif response.status == 404:
                raise NextCenturyError(
                    f"Property not found. Check property_id: {self.property_id}"
                )
            elif response.status == 403:
                raise NextCenturyError(
                    f"Access denied to property {self.property_id}. Check permissions."
                )
            else:
                raise NextCenturyError(f"Failed to get units: HTTP {response.status}")

        units = response.json()

        if not units:
            raise NextCenturyError(
                f"No units found for property {self.property_id}. Check property configuration."
            )

        log.info(f"Found {len(units)} units for property {self.property_id}")
        return units

    def get_current_readings(self, days: int = 60) -> Tuple[Dict[str, dict], List[str]]:
        """
        Get current meter readings for all units (in gallons, with CCF conversion).

        Args:
            days: Number of days to look back (default: 60)

        Returns:
            Tuple of (Dictionary mapping unit names to reading data, List of warnings):
            ({"401": {"gallons": 1788, "ccf": 2.39}}, ["warning1", ...])
        """
        to_date = datetime.now()
        from_date = to_date - timedelta(days=days)
        readings, warnings = self._get_readings_for_period(from_date, to_date)

        result = {
            r.unit_name: {
                "gallons": r.usage_gallons,
                "ccf": r.usage_ccf,
            }
            for r in readings
        }
        return result, warnings

    def get_readings_for_bill_period(
        self, bill_start_date: str, bill_end_date: str
    ) -> Tuple[Dict[str, dict], List[str]]:
        """
        Get meter readings for a specific billing period.

        Args:
            bill_start_date: Period start date (e.g., "Dec 01, 2024" or "12/01/2024")
            bill_end_date: Period end date (e.g., "Dec 31, 2024" or "12/31/2024")

        Returns:
            Tuple of (Dictionary mapping unit names to reading data, List of warnings):
            ({"401": {"gallons": 1788, "ccf": 2.39}}, ["warning1", ...])
        """
        # Parse the date strings
        try:
            start_date = self._parse_date(bill_start_date)
            end_date = self._parse_date(bill_end_date)
        except ValueError as e:
            raise NextCenturyError(f"Invalid date format: {e}")

        readings, warnings = self._get_readings_for_period(start_date, end_date)

        result = {
            r.unit_name: {
                "gallons": r.usage_gallons,
                "ccf": r.usage_ccf,
            }
            for r in readings
        }
        return result, warnings

    def _parse_date(self, date_str: str) -> datetime:
        """Parse various date string formats into datetime."""
        # Try different formats
        formats = [
            "%b %d, %Y",  # "Dec 01, 2024"
            "%B %d, %Y",  # "December 01, 2024"
            "%m/%d/%Y",  # "12/01/2024"
            "%Y-%m-%d",  # "2024-12-01"
        ]

        for fmt in formats:
            try:
                return datetime.strptime(date_str, fmt)
            except ValueError:
                continue

        raise ValueError(f"Could not parse date: {date_str}")

    def _get_report_template(self) -> dict:
        """Fetch the Usage report template from NextCentury."""
        assert self._page is not None
        assert self._auth_token is not None

        headers: Dict[str, str] = {"Authorization": self._auth_token}
        url = f"{self.API_URL}/ReportTemplates/rt_1"

        response = self._page.request.get(url, headers=headers)
        if not response.ok:
            raise NextCenturyError(
                f"Failed to fetch report template: HTTP {response.status}"
            )

        return response.json()

    def _get_readings_for_period(
        self, start_date: datetime, end_date: datetime
    ) -> Tuple[List[UnitReading], List[str]]:
        """
        Get meter readings for a specific billing period using NextCentury's
        Usage report API (RunReportTemplate). This correctly handles data gaps
        by using the last known reading before the period as the baseline.

        Args:
            start_date: Period start date
            end_date: Period end date

        Returns:
            Tuple of (List of UnitReading objects with usage data, List of warning messages)
        """
        self._login()
        assert self._page is not None
        assert self._auth_token is not None

        # The RunReportTemplate API is inclusive on both start and end dates.
        # Seattle Utilities billing periods share boundary dates (bill 1 ends
        # Oct 08, bill 2 starts Oct 08), so we subtract one day from end_date
        # to avoid double-counting the boundary day.
        adjusted_end = end_date - timedelta(days=1)
        from_str = start_date.strftime("%Y-%m-%dT08:00:00.000Z")
        to_str = adjusted_end.strftime("%Y-%m-%dT08:00:00.000Z")

        log.info(f"Running usage report from {from_str} to {to_str}...")

        headers: Dict[str, str] = {
            "Authorization": self._auth_token,
            "Content-Type": "application/json",
        }

        template = self._get_report_template()

        payload = json.dumps(
            {
                "template": template,
                "startDate": from_str,
                "endDate": to_str,
                "contextId": self.property_id,
            }
        )

        response = self._page.request.post(
            f"{self.API_URL}/RunReportTemplate",
            headers=headers,
            data=payload,
        )

        if not response.ok:
            raise NextCenturyError(
                f"Failed to run usage report: HTTP {response.status}"
            )

        report_rows = response.json()

        readings = []
        warnings = []
        units_without_data = []

        for row in report_rows:
            # Report columns: UNIT, BUILDING, SERIAL_NUMBER, METER_READ, METER_USAGE, UTILITY_TYPE, UTILITY_UNIT
            unit_name = str(row[0]["value"])
            meter_read = int(row[3]["value"])
            usage_gallons = int(row[4]["value"])
            usage_ccf = round(usage_gallons / 748.0, 2)

            if usage_gallons == 0:
                units_without_data.append(unit_name)

            readings.append(
                UnitReading(
                    unit_id=f"u_{unit_name}",
                    unit_name=unit_name,
                    usage_gallons=usage_gallons,
                    usage_ccf=usage_ccf,
                    meter_read=meter_read,
                )
            )

            log.info(f"  {unit_name}: {usage_ccf:.2f} CCF ({usage_gallons} gallons)")

        if units_without_data:
            warnings.append(f"Zero usage for period: {', '.join(units_without_data)}")

        return readings, warnings

    def close(self):
        """Close the browser and clean up resources."""
        if self._browser:
            self._browser.close()
            self._browser = None
        if self._playwright:
            self._playwright.stop()
            self._playwright = None
        self._auth_token = None
