from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..deps import current_user
from ..models import User
from ..schemas import CalendarOut, Conflict
from ..services import events as svc
from .events import to_out, visible_pairs

router = APIRouter(tags=["calendar"])


@router.get("/calendar", response_model=CalendarOut)
async def calendar(
    frm: datetime = Query(alias="from"),
    to: datetime = Query(...),
    with_conflicts: bool = True,
    me: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    pairs = await visible_pairs(db, me, frm, to)
    events = [await to_out(db, ev, me, pt) for ev, pt in pairs]
    conflicts: list[Conflict] = []
    if with_conflicts:
        conflicts = [
            Conflict(**c) for c in svc.find_conflicts([(e, p) for e, p in pairs if p is not None])
        ]
    return CalendarOut(events=events, conflicts=conflicts)
