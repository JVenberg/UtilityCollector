from fastapi import APIRouter
from fastapi import Depends
from fastapi import Form
from fastapi import Request
from fastapi.responses import HTMLResponse
from fastapi.responses import RedirectResponse
from sqlmodel import Session

from db import crud
from db import models
from db.database import engine
from web.templating import templates

router = APIRouter()


def get_db_session():
    """
    Dependency to get a database session.
    """
    with Session(engine) as session:
        yield session


@router.get("/units", response_class=HTMLResponse)
def read_units_page(request: Request, db: Session = Depends(get_db_session)):
    """
    Retrieve all units and render the units management page.
    """
    units = crud.get_all_units(db)
    return templates.TemplateResponse(
        request=request, name="units.html", context={"units": units}
    )


@router.get("/units/{unit_id}/edit", response_class=HTMLResponse)
def edit_unit_page(
    unit_id: int, request: Request, db: Session = Depends(get_db_session)
):
    """
    Show the page for editing an existing unit.
    """
    unit = crud.get_unit_by_id(db, unit_id=unit_id)
    if unit:
        # Eagerly load the trash_cans relationship
        unit.trash_cans
    return templates.TemplateResponse(
        request=request, name="edit_unit.html", context={"unit": unit}
    )


@router.post("/units/{unit_id}/edit", response_class=RedirectResponse)
def update_unit(
    unit_id: int,
    name: str = Form(...),
    sqft: int = Form(...),
    submeter_id: str = Form(...),
    email: str = Form(...),
    db: Session = Depends(get_db_session),
):
    """
    Update a unit's information from form data.
    """
    unit_to_update = crud.get_unit_by_id(db, unit_id=unit_id)
    if unit_to_update:
        unit_to_update.name = name
        unit_to_update.sqft = sqft
        unit_to_update.submeter_id = submeter_id
        unit_to_update.email = email
        crud.update_unit(db, unit=unit_to_update)
    return RedirectResponse(url="/units", status_code=303)


@router.post("/units/{unit_id}/delete", response_class=RedirectResponse)
def delete_unit(unit_id: int, db: Session = Depends(get_db_session)):
    """
    Delete a unit.
    """
    unit_to_delete = crud.get_unit_by_id(db, unit_id=unit_id)
    if unit_to_delete:
        crud.delete_unit(db, unit=unit_to_delete)
    return RedirectResponse(url="/units", status_code=303)


@router.post("/units", response_class=RedirectResponse)
def create_unit(
    name: str = Form(...),
    sqft: int = Form(...),
    submeter_id: str = Form(...),
    email: str = Form(...),
    db: Session = Depends(get_db_session),
):
    """
    Create a new unit from form data.
    """
    new_unit = models.Unit(name=name, sqft=sqft, submeter_id=submeter_id, email=email)
    crud.create_unit(db, new_unit)
    return RedirectResponse(url="/units", status_code=303)


@router.post("/units/{unit_id}/cans", response_class=RedirectResponse)
def add_trash_can_to_unit(
    unit_id: int,
    service_type: str = Form(...),
    size: int = Form(...),
    db: Session = Depends(get_db_session),
):
    """
    Add a new trash can to a specific unit.
    """
    new_can = models.TrashCan(service_type=service_type, size=size, unit_id=unit_id)
    crud.create_trash_can(db, can=new_can)
    return RedirectResponse(url=f"/units/{unit_id}/edit", status_code=303)


@router.post("/units/{unit_id}/cans/{can_id}/delete", response_class=RedirectResponse)
def delete_trash_can_from_unit(
    unit_id: int, can_id: int, db: Session = Depends(get_db_session)
):
    """
    Delete a trash can from a unit.
    """
    can_to_delete = crud.get_trash_can_by_id(db, can_id=can_id)
    if can_to_delete and can_to_delete.unit_id == unit_id:
        crud.delete_trash_can(db, can=can_to_delete)
    return RedirectResponse(url=f"/units/{unit_id}/edit", status_code=303)
