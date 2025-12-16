"""
Seattle Utilities Scraper

Uses Playwright to scrape bills from the Seattle Utilities website.
Adapted from the original bill_manager.py scraping logic.
"""

import logging
from pathlib import Path
from typing import Optional

from playwright.sync_api import Browser
from playwright.sync_api import BrowserContext
from playwright.sync_api import Page
from playwright.sync_api import sync_playwright

log = logging.getLogger(__name__)


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
        """
        Initialize the scraper.

        Args:
            username: Seattle Utilities login username
            password: Seattle Utilities login password
            account: Account number (e.g., "4553370429")
        """
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

        log.info("Navigating to utility login page...")
        self._page.goto(self.LOGIN_URL)
        self._page.wait_for_selector('input[name="userName"]', timeout=30000)

        log.info("Logging in...")
        self._page.locator('input[name="userName"]').fill(self.username)
        self._page.locator('input[name="password"]').fill(self.password)
        self._page.locator('button[type="submit"]').click()

        # Wait for SSO redirect to complete - ends up at ssohome or eportal
        log.info("Waiting for SSO redirect to complete...")
        self._page.wait_for_url("**/eportal/**", timeout=60000)
        self._page.wait_for_load_state("networkidle", timeout=30000)

        self._logged_in = True
        log.info(f"Login successful, current URL: {self._page.url}")

    def _navigate_to_billing_history(self):
        """Navigate to the billing history page."""
        self._login()

        billing_url = f"{self.BASE_URL}/eportal/#/billinghistory?acct={self.account}"
        log.info(f"Navigating to billing history: {billing_url}")
        self._page.goto(billing_url)

        # Wait for page load and network to settle
        self._page.wait_for_load_state("networkidle", timeout=30000)

        # Try to find the billing table - may take a moment to render
        log.info("Waiting for billing table to load...")
        try:
            self._page.wait_for_selector("table.app-table", timeout=30000)
        except Exception as e:
            # Log current URL and page content for debugging
            log.error(f"Failed to find billing table. Current URL: {self._page.url}")
            log.error(f"Page title: {self._page.title()}")
            # Try alternative selectors
            if self._page.locator(".bill-history-table").count() > 0:
                log.info("Found alternative table selector: .bill-history-table")
            elif self._page.locator("table").count() > 0:
                log.info(f"Found {self._page.locator('table').count()} tables on page")
            raise e

    def check_for_new_bills(self) -> list[dict]:
        """
        Check for available bills in billing history.

        Returns:
            List of bills with date and amount:
            [{"date": "12/01/2024", "amount": 425.67}, ...]
        """
        self._navigate_to_billing_history()

        # Get all bill rows, filtering out non-bill rows
        all_rows = self._page.locator("table.app-table tbody tr").all()
        bills = []

        for row in all_rows:
            first_cell_text = row.locator("td:first-child").inner_text()
            # Skip rows that don't look like dates (MM/DD/YYYY format)
            if "/" in first_cell_text and len(first_cell_text.split("/")) == 3:
                # Try to get amount from second column
                try:
                    amount_text = row.locator("td:nth-child(2)").inner_text()
                    amount = float(amount_text.replace("$", "").replace(",", ""))
                except (ValueError, Exception):
                    amount = 0.0

                bills.append(
                    {
                        "date": first_cell_text,
                        "amount": amount,
                    }
                )

        log.info(f"Found {len(bills)} bills in billing history")
        return bills

    def download_bill(self, bill_date: str) -> Path:
        """
        Download a specific bill by date.

        Args:
            bill_date: Bill date string in MM/DD/YYYY format

        Returns:
            Path to the downloaded PDF file
        """
        self._navigate_to_billing_history()

        # Find and click the bill row for the specified date
        all_rows = self._page.locator("table.app-table tbody tr").all()

        for row in all_rows:
            first_cell_text = row.locator("td:first-child").inner_text()
            if first_cell_text == bill_date:
                log.info(f"Found bill for {bill_date}, navigating to viewer...")
                row.locator("a.view-bill-link").click()
                break
        else:
            raise ValueError(f"Bill not found for date: {bill_date}")

        # Wait for bill viewer page
        self._page.wait_for_url("**/ViewBill.aspx", timeout=25000)

        # Download PDF
        log.info("Downloading bill PDF...")
        with self._page.expect_download() as download_info:
            self._page.locator("#main_divBillToolBar #main_PDF").click()

        download = download_info.value
        temp_path = Path(f"/tmp/bill_{bill_date.replace('/', '-')}.pdf")
        download.save_as(temp_path)

        log.info(f"Bill downloaded to: {temp_path}")
        return temp_path

    def download_all_bills(self) -> list[tuple[Path, str]]:
        """
        Download all available bills.

        Returns:
            List of tuples: (temp_path, bill_date) for each downloaded bill
        """
        self._navigate_to_billing_history()

        # Get all bill rows
        all_rows = self._page.locator("table.app-table tbody tr").all()
        bill_rows = []

        for row in all_rows:
            first_cell_text = row.locator("td:first-child").inner_text()
            if "/" in first_cell_text and len(first_cell_text.split("/")) == 3:
                bill_rows.append(first_cell_text)

        log.info(f"Found {len(bill_rows)} bills to download")

        downloaded = []
        for i, bill_date in enumerate(bill_rows):
            try:
                log.info(f"Processing bill {i + 1}/{len(bill_rows)}: {bill_date}")

                # Find and click the row for this date
                all_rows = self._page.locator("table.app-table tbody tr").all()
                for row in all_rows:
                    if row.locator("td:first-child").inner_text() == bill_date:
                        row.locator("a.view-bill-link").click()
                        break

                self._page.wait_for_url("**/ViewBill.aspx", timeout=25000)

                # Download PDF
                with self._page.expect_download() as download_info:
                    self._page.locator("#main_divBillToolBar #main_PDF").click()

                download = download_info.value
                temp_path = Path(f"/tmp/bill_{bill_date.replace('/', '-')}_{i}.pdf")
                download.save_as(temp_path)

                downloaded.append((temp_path, bill_date))
                log.info(f"Downloaded bill {bill_date}")

                # Navigate back to billing history
                self._navigate_to_billing_history()

            except Exception as e:
                log.error(f"Error downloading bill {bill_date}: {e}")
                # Try to recover by navigating back
                try:
                    self._navigate_to_billing_history()
                except Exception:
                    pass

        log.info(f"Successfully downloaded {len(downloaded)} bills")
        return downloaded

    def close(self):
        """Close the browser and clean up resources."""
        if self._browser:
            self._browser.close()
            self._browser = None
        if self._playwright:
            self._playwright.stop()
            self._playwright = None
        self._logged_in = False
