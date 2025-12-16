"""
NextCentury Meters Scraper

Uses Playwright to scrape meter readings from NextCentury Meters website.
This scraper needs to be customized based on the actual site structure.
"""

import logging
from typing import Dict
from typing import Optional

from playwright.sync_api import Browser
from playwright.sync_api import BrowserContext
from playwright.sync_api import Page
from playwright.sync_api import sync_playwright

log = logging.getLogger(__name__)


class NextCenturyMetersScraper:
    """
    Scrapes meter readings from NextCentury Meters website using Playwright.

    Note: This scraper needs to be customized based on the actual NextCentury
    website structure. The current implementation is a template based on
    common patterns.

    Usage:
        scraper = NextCenturyMetersScraper(username, password, property_id)
        try:
            readings = scraper.get_current_readings()
        finally:
            scraper.close()
    """

    BASE_URL = "https://app.nextcenturymeters.com"
    LOGIN_URL = f"{BASE_URL}/login"

    def __init__(self, username: str, password: str, property_id: Optional[str] = None):
        """
        Initialize the scraper.

        Args:
            username: NextCentury login username/email
            password: NextCentury login password
            property_id: Optional property ID for multi-property accounts
        """
        self.username = username
        self.password = password
        self.property_id = property_id

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
        """Log into NextCentury website."""
        if self._logged_in:
            return

        self._ensure_browser()
        assert self._page is not None  # Type narrowing for mypy

        log.info("Navigating to NextCentury login page...")
        self._page.goto(self.LOGIN_URL)
        self._page.wait_for_load_state("networkidle", timeout=25000)

        log.info("Logging in...")

        # Try common selector patterns for login form
        # These may need to be adjusted based on actual site
        try:
            # Try email/username field
            email_selectors = [
                'input[type="email"]',
                'input[name="email"]',
                'input[name="username"]',
                'input[id="email"]',
                "#username",
            ]
            for selector in email_selectors:
                if self._page.locator(selector).count() > 0:
                    self._page.locator(selector).fill(self.username)
                    break

            # Try password field
            password_selectors = [
                'input[type="password"]',
                'input[name="password"]',
                "#password",
            ]
            for selector in password_selectors:
                if self._page.locator(selector).count() > 0:
                    self._page.locator(selector).fill(self.password)
                    break

            # Try submit button
            submit_selectors = [
                'button[type="submit"]',
                'input[type="submit"]',
                'button:has-text("Log in")',
                'button:has-text("Login")',
                'button:has-text("Sign in")',
            ]
            for selector in submit_selectors:
                if self._page.locator(selector).count() > 0:
                    self._page.locator(selector).click()
                    break

            self._page.wait_for_load_state("networkidle", timeout=25000)
            self._logged_in = True
            log.info("Login successful")

        except Exception as e:
            log.error(f"Login failed: {e}")
            raise

    def get_current_readings(self) -> Dict[str, float]:
        """
        Get current meter readings for all submeters.

        Returns:
            Dictionary mapping meter/submeter IDs to their current readings:
            {"SM-401": 123.45, "SM-402": 234.56, ...}
        """
        self._login()
        assert self._page is not None  # Type narrowing for mypy

        log.info("Fetching meter readings...")
        readings: Dict[str, float] = {}

        try:
            # Navigate to readings/dashboard page
            # These URLs need to be adjusted based on actual site structure
            possible_dashboard_urls = [
                f"{self.BASE_URL}/dashboard",
                f"{self.BASE_URL}/readings",
                f"{self.BASE_URL}/meters",
                (
                    f"{self.BASE_URL}/property/{self.property_id}"
                    if self.property_id
                    else None
                ),
            ]

            for url in possible_dashboard_urls:
                if url:
                    try:
                        self._page.goto(url)
                        self._page.wait_for_load_state("networkidle", timeout=10000)
                        break
                    except Exception:
                        continue

            # Try to find and extract meter readings from the page
            # This section needs customization based on actual page structure

            # Strategy 1: Look for a table with readings
            table_selectors = [
                "table.readings",
                "table.meters",
                "table",
                ".meter-table",
                ".readings-table",
            ]

            for selector in table_selectors:
                if self._page.locator(selector).count() > 0:
                    rows = self._page.locator(f"{selector} tbody tr").all()
                    for row in rows:
                        try:
                            # Try to extract meter ID and reading
                            cells = row.locator("td").all()
                            if len(cells) >= 2:
                                meter_id = cells[0].inner_text().strip()
                                reading_text = cells[1].inner_text().strip()
                                # Clean up reading text and convert to float
                                reading = float(
                                    reading_text.replace(",", "").replace(" ", "")
                                )
                                readings[meter_id] = reading
                        except (ValueError, IndexError):
                            continue

                    if readings:
                        break

            # Strategy 2: Look for meter cards/elements
            if not readings:
                card_selectors = [
                    ".meter-card",
                    ".reading-card",
                    "[data-meter]",
                ]

                for selector in card_selectors:
                    cards = self._page.locator(selector).all()
                    for card in cards:
                        try:
                            # Try to extract from card structure
                            meter_id = (
                                card.get_attribute("data-meter-id")
                                or card.locator(".meter-id, .meter-name").inner_text()
                            )
                            reading_text = card.locator(
                                ".reading, .value, .current-reading"
                            ).inner_text()
                            reading = float(
                                reading_text.replace(",", "").replace(" ", "")
                            )
                            readings[meter_id.strip()] = reading
                        except (ValueError, AttributeError):
                            continue

                    if readings:
                        break

            # Strategy 3: Look for export/download option
            if not readings:
                export_selectors = [
                    "button:has-text('Export')",
                    "button:has-text('Download')",
                    "a:has-text('Export CSV')",
                    ".export-btn",
                ]

                for selector in export_selectors:
                    if self._page.locator(selector).count() > 0:
                        log.info("Found export button - attempting CSV export")
                        # This would need to handle file download and CSV parsing
                        # For now, just log that it's available
                        log.warning("CSV export found but not implemented")
                        break

            log.info(f"Found {len(readings)} meter readings")

        except Exception as e:
            log.error(f"Error fetching readings: {e}")

        return readings

    def get_readings_for_period(
        self, start_date: str, end_date: str
    ) -> Dict[str, float]:
        """
        Get meter readings for a specific billing period.

        Args:
            start_date: Period start date (format depends on site)
            end_date: Period end date

        Returns:
            Dictionary mapping meter IDs to their readings for the period
        """
        self._login()
        assert self._page is not None  # Type narrowing for mypy

        log.info(f"Fetching readings for period {start_date} to {end_date}...")

        # This needs to be implemented based on actual site structure
        # Most sites have a date range picker or historical readings page

        # Placeholder - return current readings for now
        log.warning(
            "Period-specific readings not implemented, returning current readings"
        )
        return self.get_current_readings()

    def close(self):
        """Close the browser and clean up resources."""
        if self._browser:
            self._browser.close()
            self._browser = None
        if self._playwright:
            self._playwright.stop()
            self._playwright = None
        self._logged_in = False
