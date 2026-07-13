"""Shared browser configuration for the Playwright scrapers."""

# Seattle's WAF serves a bot block page to Playwright's default HeadlessChrome UA.
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
)
