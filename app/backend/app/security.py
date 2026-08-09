"""Проверка initData от Telegram и выдача JWT."""

import hashlib
import hmac
import json
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl

from jose import JWTError, jwt

from .config import settings

ALG = "HS256"


class AuthError(Exception):
    pass


def verify_init_data(init_data: str) -> dict:
    """Проверяем подпись WebApp initData секретом бота.

    Секрет = HMAC-SHA256("WebAppData", bot_token), затем сверяем hash от
    отсортированной строки пар ключ=значение.
    """
    if not init_data:
        raise AuthError("initData пуст")

    pairs = dict(parse_qsl(init_data, keep_blank_values=True))
    received = pairs.pop("hash", None)
    if not received:
        raise AuthError("в initData нет hash")

    check_string = "\n".join(f"{k}={pairs[k]}" for k in sorted(pairs))
    secret = hmac.new(b"WebAppData", settings.bot_token.encode(), hashlib.sha256).digest()
    calculated = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(calculated, received):
        raise AuthError("подпись initData не сходится")

    auth_date = int(pairs.get("auth_date", "0"))
    if settings.initdata_ttl and time.time() - auth_date > settings.initdata_ttl:
        raise AuthError("initData просрочена")

    user_raw = pairs.get("user")
    if not user_raw:
        raise AuthError("в initData нет user")

    return {
        "user": json.loads(user_raw),
        "start_param": pairs.get("start_param"),
        "auth_date": auth_date,
    }


def _token(sub: str, ttl: timedelta, kind: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {"sub": sub, "typ": kind, "iat": now, "exp": now + ttl}
    return jwt.encode(payload, settings.jwt_secret, algorithm=ALG)


def make_tokens(user_id: str) -> dict:
    return {
        "access": _token(user_id, timedelta(minutes=settings.access_ttl_min), "access"),
        "refresh": _token(user_id, timedelta(days=settings.refresh_ttl_days), "refresh"),
        "expires_in": settings.access_ttl_min * 60,
    }


def decode(token: str, kind: str = "access") -> str:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[ALG])
    except JWTError as exc:
        raise AuthError("токен недействителен") from exc
    if payload.get("typ") != kind:
        raise AuthError("не тот тип токена")
    return payload["sub"]
