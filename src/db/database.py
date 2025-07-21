from sqlmodel import create_engine

from core.config import settings

# The connect_args are recommended for SQLite to allow multiple threads to access it,
# which is necessary for FastAPI's design.
connect_args = {"check_same_thread": False}
engine = create_engine(settings.DATABASE_URL, echo=True, connect_args=connect_args)
