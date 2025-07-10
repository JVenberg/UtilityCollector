from pathlib import Path

from fastapi.templating import Jinja2Templates

# Configure and export the templates instance
templates = Jinja2Templates(directory=Path("app/web/templates"))
