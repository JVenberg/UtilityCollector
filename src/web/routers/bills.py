from fastapi import APIRouter
from fastapi import Depends
from fastapi import Request
from fastapi.responses import HTMLResponse
from fastapi.responses import RedirectResponse
from sqlmodel import Session

from db import crud
from db.database import engine
from services.bill_manager import BillManager
from services.invoice_service import InvoiceService
from web.templating import templates

router = APIRouter()


def get_db_session():
    """
    Dependency to get a database session.
    """
    with Session(engine) as session:
        yield session


@router.get("/bills", response_class=HTMLResponse)
def read_bills(request: Request, db: Session = Depends(get_db_session)):
    """
    Retrieve all bills from the database and render them in an HTML template.
    """
    bills = crud.get_all_bills(db)
    return templates.TemplateResponse(
        request=request, name="bills.html", context={"bills": bills}
    )


@router.get("/bills/{bill_id}", response_class=HTMLResponse)
def read_bill_detail(
    bill_id: int, request: Request, db: Session = Depends(get_db_session)
):
    """
    Retrieve a single bill and all related data to render the detail/split page.
    """
    bill = crud.get_bill_by_id(db, bill_id=bill_id)
    if not bill:
        return HTMLResponse(status_code=404, content="Bill not found")

    bill_manager = BillManager(db=db)
    parsed_data = bill_manager._parse_bill(bill.pdf_path)
    units = crud.get_all_units(db)
    parsed_adjustments = crud.get_parsed_adjustments_for_bill(db, bill_id)

    invoice_service = InvoiceService(db=db)
    invoices = invoice_service.calculate_invoices(bill)

    return templates.TemplateResponse(
        request=request,
        name="bill_detail.html",
        context={
            "bill": bill,
            "details": parsed_data,
            "units": units,
            "invoices": invoices,
            "parsed_adjustments": parsed_adjustments,
        },
    )


@router.post("/bills/{bill_id}", response_class=RedirectResponse)
async def split_bill_action(
    bill_id: int, request: Request, db: Session = Depends(get_db_session)
):
    """
    Process the sub-meter readings and generate invoices for each unit.
    """
    form_data = await request.form()
    form_dict = {key: form_data.get(key) for key in form_data.keys()}
    invoice_service = InvoiceService(db=db)
    invoice_service.save_split_data(bill_id=bill_id, form_data=form_dict)
    return RedirectResponse(url=f"/bills/{bill_id}", status_code=303)
