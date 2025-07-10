from typing import Sequence

from sqlalchemy.orm import selectinload
from sqlmodel import Session
from sqlmodel import desc
from sqlmodel import select

from app.db import models


def get_bill_by_pdf_path(db: Session, pdf_path: str) -> models.Bill | None:
    """
    Retrieve a bill from the database by its PDF path.
    """
    statement = select(models.Bill).where(models.Bill.pdf_path == pdf_path)
    return db.exec(statement).first()


def create_bill(db: Session, bill: models.Bill) -> models.Bill:
    """
    Add a new bill record to the database.
    """
    db.add(bill)
    db.commit()
    db.refresh(bill)
    return bill


def get_all_bills(db: Session) -> Sequence[models.Bill]:
    """
    Retrieve all bills from the database, ordered by most recent first.
    """
    statement = select(models.Bill).order_by(desc(models.Bill.bill_date))
    return db.exec(statement).all()


# --- Trash Can CRUD Functions ---


def create_trash_can(db: Session, can: models.TrashCan) -> models.TrashCan:
    """
    Add a new trash can to the database.
    """
    db.add(can)
    db.commit()
    db.refresh(can)
    return can


def get_trash_can_by_id(db: Session, can_id: int) -> models.TrashCan | None:
    """
    Retrieve a single trash can by its primary key ID.
    """
    return db.get(models.TrashCan, can_id)


def delete_trash_can(db: Session, can: models.TrashCan):
    """
    Delete a trash can from the database.
    """
    db.delete(can)
    db.commit()


# --- Unit CRUD Functions ---


def create_unit(db: Session, unit: models.Unit) -> models.Unit:
    """
    Add a new unit to the database.
    """
    db.add(unit)
    db.commit()
    db.refresh(unit)
    return unit


def get_all_units(db: Session) -> Sequence[models.Unit]:
    """
    Retrieve all units from the database.
    """
    statement = (
        select(models.Unit)
        .options(selectinload(models.Unit.trash_cans))
        .order_by(models.Unit.name)
    )
    return db.exec(statement).all()


def get_unit_by_id(db: Session, unit_id: int) -> models.Unit | None:
    """
    Retrieve a single unit by its primary key ID.
    """
    statement = (
        select(models.Unit)
        .options(selectinload(models.Unit.trash_cans))
        .where(models.Unit.id == unit_id)
    )
    return db.exec(statement).first()


def delete_unit(db: Session, unit: models.Unit):
    """
    Delete a unit from the database.
    """
    db.delete(unit)
    db.commit()


def update_unit(db: Session, unit: models.Unit) -> models.Unit:
    """
    Update a unit's details in the database.
    """
    db.add(unit)
    db.commit()
    db.refresh(unit)
    return unit


def get_bill_by_id(db: Session, bill_id: int) -> models.Bill | None:
    """
    Retrieve a single bill by its primary key ID.
    """
    return db.get(models.Bill, bill_id)


def update_bill(db: Session, bill: models.Bill) -> models.Bill:
    """
    Update a bill's details in the database.
    """
    db.add(bill)
    db.commit()
    db.refresh(bill)
    return bill


# --- SubMeterReading and Adjustment CRUD Functions ---


def create_sub_meter_reading(
    db: Session, reading: models.SubMeterReading
) -> models.SubMeterReading:
    """
    Add a new sub_meter_reading to the database.
    """
    db.add(reading)
    db.commit()
    db.refresh(reading)
    return reading


def create_parsed_adjustment(
    db: Session, adjustment: models.ParsedAdjustment
) -> models.ParsedAdjustment:
    """
    Add a new parsed adjustment to the database.
    """
    db.add(adjustment)
    db.commit()
    db.refresh(adjustment)
    return adjustment


def create_adjustment_unit_selection(
    db: Session, selection: models.AdjustmentUnitSelection
) -> models.AdjustmentUnitSelection:
    """
    Add a new adjustment unit selection to the database.
    """
    db.add(selection)
    db.commit()
    db.refresh(selection)
    return selection


def get_readings_for_bill(db: Session, bill_id: int) -> list[models.SubMeterReading]:
    """
    Retrieve all sub_meter_readings for a specific bill.
    """
    statement = select(models.SubMeterReading).where(
        models.SubMeterReading.bill_id == bill_id
    )
    results = db.exec(statement).all()
    return list(results)


def get_parsed_adjustments_for_bill(
    db: Session, bill_id: int
) -> list[models.ParsedAdjustment]:
    """
    Retrieve all parsed adjustments for a specific bill.
    """
    statement = select(models.ParsedAdjustment).where(
        models.ParsedAdjustment.bill_id == bill_id
    )
    results = db.exec(statement).all()
    return list(results)


def get_adjustment_unit_selections_for_adjustment(
    db: Session, adjustment_id: int
) -> list[models.AdjustmentUnitSelection]:
    """
    Retrieve all unit selections for a specific adjustment.
    """
    statement = select(models.AdjustmentUnitSelection).where(
        models.AdjustmentUnitSelection.adjustment_id == adjustment_id
    )
    results = db.exec(statement).all()
    return list(results)


def delete_readings_for_bill(db: Session, bill_id: int):
    """
    Delete all sub_meter_readings for a specific bill.
    """
    readings = get_readings_for_bill(db, bill_id)
    for reading in readings:
        db.delete(reading)
    db.commit()


def delete_parsed_adjustments_for_bill(db: Session, bill_id: int):
    """
    Delete all parsed adjustments and their unit selections for a specific bill.
    """
    adjustments = get_parsed_adjustments_for_bill(db, bill_id)
    for adjustment in adjustments:
        # Delete associated unit selections first
        if adjustment.id is not None:
            selections = get_adjustment_unit_selections_for_adjustment(
                db, adjustment.id
            )
            for selection in selections:
                db.delete(selection)
        # Then delete the adjustment
        db.delete(adjustment)
    db.commit()


def delete_adjustment_unit_selections_for_adjustment(db: Session, adjustment_id: int):
    """
    Delete all unit selections for a specific adjustment.
    """
    selections = get_adjustment_unit_selections_for_adjustment(db, adjustment_id)
    for selection in selections:
        db.delete(selection)
    db.commit()
