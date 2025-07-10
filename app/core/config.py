import logging

from pydantic_settings import BaseSettings
from pydantic_settings import SettingsConfigDict


class Settings(BaseSettings):
    # --- Utility Account ---
    UTILITY_USERNAME: str
    UTILITY_PASSWORD: str

    # --- Database ---
    DATABASE_URL: str

    # --- Logging ---
    LOG_LEVEL: str = "INFO"

    # --- Gmail API ---
    GMAIL_CREDENTIALS_PATH: str = "/app/gcreds/credentials.json"
    GMAIL_TOKEN_PATH: str = "/app/gcreds/token.json"
    GMAIL_SENDER: str

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


settings = Settings()

# Configure logging based on settings
logging.basicConfig(level=settings.LOG_LEVEL)
