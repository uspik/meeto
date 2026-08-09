from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..deps import current_user
from ..models import User
from ..schemas import UserOut

router = APIRouter(tags=["me"])


class MePatch(BaseModel):
    timezone: str | None = None
    language_code: str | None = None


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(current_user)):
    return user


@router.patch("/me", response_model=UserOut)
async def edit_me(
    body: MePatch, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)
):
    for key, val in body.model_dump(exclude_none=True).items():
        setattr(user, key, val)
    await db.commit()
    await db.refresh(user)
    return user
