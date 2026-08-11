import logging
import secrets

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db import get_db
from ..models import User
from ..schemas import TokensOut, UserOut
from ..security import AuthError, decode, make_tokens, verify_init_data
from ..services import invites as inv

router = APIRouter(prefix="/auth", tags=["auth"])

# отдельный служебный аккаунт, чтобы отладка не смешивалась с живыми людьми
DEV_TG_ID = -1


@router.post("/telegram", response_model=TokensOut)
async def login(authorization: str = Header(default=""), db: AsyncSession = Depends(get_db)):
    """Вход по initData. Заголовок: Authorization: tma <initData>."""
    scheme, _, init_data = authorization.partition(" ")
    if scheme.lower() != "tma":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "ожидается схема tma")
    try:
        data = verify_init_data(init_data)
    except AuthError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc

    tg = data["user"]
    res = await db.execute(select(User).where(User.tg_id == tg["id"]))
    user = res.scalar_one_or_none()
    if user is None:
        user = User(tg_id=tg["id"], timezone=settings.default_tz)
        db.add(user)

    user.username = tg.get("username")
    user.first_name = tg.get("first_name") or ""
    user.last_name = tg.get("last_name")
    user.photo_url = tg.get("photo_url")
    user.language_code = tg.get("language_code") or "ru"
    user.is_bot_blocked = False
    await db.flush()

    # приглашения, оставленные до появления человека в Meeto
    applied = await inv.apply_for(db, user)
    if applied:
        logging.getLogger("meeto.auth").info(
            "применено отложенных приглашений: %s для @%s", applied, user.username
        )

    await db.commit()
    await db.refresh(user)

    return TokensOut(
        **make_tokens(str(user.id)),
        user=UserOut.model_validate(user),
        start_param=data.get("start_param"),
    )


@router.post("/dev", response_model=TokensOut)
async def dev_login(
    token: str = Header(default="", alias="X-Dev-Token"),
    db: AsyncSession = Depends(get_db),
):
    """Вход без Telegram — только для отладки интерфейса в браузере.

    Работает, если в .env задан DEV_LOGIN_TOKEN. Пустое значение полностью
    выключает ручку: без него отсюда нельзя войти никак.
    """
    if not settings.dev_login_token:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "отладочный вход выключен")
    if not secrets.compare_digest(token, settings.dev_login_token):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "неверный отладочный токен")

    res = await db.execute(select(User).where(User.tg_id == DEV_TG_ID))
    user = res.scalar_one_or_none()
    if user is None:
        user = User(tg_id=DEV_TG_ID, first_name="Отладка", username="devpreview",
                    timezone=settings.default_tz)
        db.add(user)
        await db.commit()
        await db.refresh(user)

    logging.getLogger("meeto.auth").warning("вход через отладочный токен")
    return TokensOut(**make_tokens(str(user.id)), user=UserOut.model_validate(user))


@router.post("/refresh", response_model=TokensOut)
async def refresh(authorization: str = Header(default=""), db: AsyncSession = Depends(get_db)):
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "нужен bearer-токен")
    try:
        user_id = decode(token, kind="refresh")
    except AuthError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc

    from uuid import UUID

    user = await db.get(User, UUID(user_id))
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "пользователь не найден")
    return TokensOut(**make_tokens(str(user.id)), user=UserOut.model_validate(user))
