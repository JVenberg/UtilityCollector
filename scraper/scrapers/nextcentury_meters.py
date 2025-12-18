"""
NextCentury Meters Scraper

Uses Playwright to login and extract JWT token, then calls the NextCentury API
directly to get meter readings. This is more reliable than scraping the UI.
"""

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
            ({"401": {"gallons": 1788, "ccf": 2.39, "start_date": "...", "end_date": "..."}}, ["warning1", ...])
        """
        to_date = datetime.now()
        from_date = to_date - timedelta(days=days)
        readings, warnings = self._get_readings_for_period(from_date, to_date)

        # Convert to dict with gallons as primary unit
        result = {
            r.unit_name: {
                "gallons": r.usage_gallons,
                "ccf": r.usage_ccf,
                "start_date": r.earliest_date,
                "end_date": r.latest_date,
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
            ({"401": {"gallons": 1788, "ccf": 2.39, "start_date": "...", "end_date": "..."}}, ["warning1", ...])
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
                "start_date": r.earliest_date,
                "end_date": r.latest_date,
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

    def _get_readings_for_period(
        self, start_date: datetime, end_date: datetime
    ) -> Tuple[List[UnitReading], List[str]]:
        """
        Get meter readings for a specific billing period.

        Args:
            start_date: Period start date
            end_date: Period end date

        Returns:
            Tuple of (List of UnitReading objects with usage data, List of warning messages)
        """
        self._login()
        assert self._page is not None
        assert self._auth_token is not None

        from_str = start_date.strftime("%Y-%m-%dT%H:%M:%S.000Z")
        to_str = end_date.strftime("%Y-%m-%dT%H:%M:%S.000Z")

        log.info(f"Fetching readings from {from_str} to {to_str}...")

        # Get all units
        units = self._get_units()

        readings = []
        warnings = []
        headers: Dict[str, str] = {"Authorization": self._auth_token}
        units_with_errors = []
        units_without_data = []

        for unit in units:
            unit_id_num = unit.get("id")
            unit_id = f"u_{unit_id_num}"
            unit_name = unit.get("name", "Unknown")

            log.info(f"Getting readings for unit {unit_name} ({unit_id})...")

            url = (
                f"{self.API_URL}/Units/{unit_id}/DailyReads?from={from_str}&to={to_str}"
            )
            response = self._page.request.get(url, headers=headers)

            if not response.ok:
                log.error(f"Failed to get readings for {unit_name}: {response.status}")
                units_with_errors.append(f"{unit_name} (HTTP {response.status})")
                continue

            daily_reads = response.json()

            if not daily_reads:
                log.warning(f"No readings found for {unit_name} in period")
                units_without_data.append(unit_name)
                continue

            # Filter to only include entries with valid pulse counts
            # The API may return entries for dates without actual meter data
            valid_reads = [
                r
                for r in daily_reads
                if r.get("latestRead", {}).get("pulseCount", 0) > 0
            ]

            if not valid_reads:
                log.warning(
                    f"No valid readings for {unit_name} in period (all pulse counts were 0)"
                )
                units_without_data.append(unit_name)
                continue

            # Sort by date ascending to ensure consistent ordering
            valid_reads.sort(key=lambda x: x.get("date", ""))

            # Get earliest (oldest date, lower pulse count) and latest (newest date, higher pulse count)
            earliest = valid_reads[0]
            latest = valid_reads[-1]

            earliest_read = earliest.get("latestRead", {})
            latest_read = latest.get("latestRead", {})

            earliest_pulses = earliest_read.get("pulseCount", 0)
            latest_pulses = latest_read.get("pulseCount", 0)
            multiplier = latest_read.get("multiplier", 1)

            # Calculate usage (pulses * multiplier = gallons)
            usage_gallons = (latest_pulses - earliest_pulses) * multiplier
            usage_ccf = usage_gallons / 748.0  # Convert gallons to CCF

            readings.append(
                UnitReading(
                    unit_id=unit_id,
                    unit_name=unit_name,
                    latest_date=latest.get("date", ""),
                    earliest_date=earliest.get("date", ""),
                    usage_gallons=usage_gallons,
                    usage_ccf=round(usage_ccf, 2),
                    latest_pulses=latest_pulses,
                    earliest_pulses=earliest_pulses,
                    multiplier=multiplier,
                )
            )

            log.info(f"  {unit_name}: {usage_ccf:.2f} CCF ({usage_gallons} gallons)")

        # Build warning messages
        if units_with_errors:
            warnings.append(f"Failed to fetch: {', '.join(units_with_errors)}")
        if units_without_data:
            warnings.append(f"No data for period: {', '.join(units_without_data)}")

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
