"""Поток изменений для открытого приложения (Server-Sent Events).

Почему SSE, а не WebSocket: клиенту нужно только слушать. SSE — обычный
HTTP-ответ, который не закрывается; переподключение при обрыве сети браузер
делает сам, а через nginx он проходит без апгрейда протокола. Для мобильного
клиента, который то и дело теряет сеть, это заметно надёжнее.

По потоку едет не состояние, а адрес изменения: «мероприятие такое-то
поменялось». Данные клиент забирает обычными ручками — иначе пришлось бы
дублировать в сообщении всю логику прав и видимости.
"""

import asyncio
import json
import logging
from uuid import UUID

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

from ..db import SessionLocal
from ..models import User
from ..security import AuthError, decode
from ..services import bus

log = logging.getLogger("meeto.stream")
router = APIRouter(tags=["stream"])

# Раз в 25 секунд шлём комментарий: пустая строка не даёт прокси закрыть
# соединение по таймауту и сразу показывает, что связь жива.
HEARTBEAT = 25


@router.get("/stream")
async def stream(request: Request, token: str = Query(default="")):
    """Токен приходит в строке запроса: EventSource не умеет заголовки.

    Это тот же короткоживущий access-токен, что и у остальных ручек, и
    ходит он по https — в отличие от refresh-токена, который сюда не пускаем.
    """
    try:
        user_id = UUID(decode(token))
    except (AuthError, ValueError):
        return StreamingResponse(iter(()), status_code=401, media_type="text/event-stream")

    async with SessionLocal() as db:
        if await db.get(User, user_id) is None:
            return StreamingResponse(iter(()), status_code=401, media_type="text/event-stream")

    async def events():
        # retry говорит браузеру, через сколько переподключаться после обрыва
        yield "retry: 3000\n\n"
        changes = bus.listen(user_id)
        try:
            async for change in changes:
                if await request.is_disconnected():
                    break
                yield f"data: {json.dumps(change, ensure_ascii=False)}\n\n"
        except asyncio.CancelledError:  # вкладку закрыли
            raise
        except Exception as exc:  # noqa: BLE001
            log.warning("поток прерван: %s", exc)
        finally:
            await changes.aclose()

    return StreamingResponse(
        _with_heartbeat(events(), request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # nginx иначе копит ответ в буфере и поток встаёт
            "X-Accel-Buffering": "no",
        },
    )


async def _with_heartbeat(source, request: Request):
    """Подмешивает в поток пустые комментарии, пока нечего сказать."""
    queue: asyncio.Queue[str | None] = asyncio.Queue()

    async def pump():
        try:
            async for chunk in source:
                await queue.put(chunk)
        finally:
            await queue.put(None)

    task = asyncio.create_task(pump())
    try:
        while True:
            try:
                chunk = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT)
            except asyncio.TimeoutError:
                if await request.is_disconnected():
                    break
                yield ": ping\n\n"
                continue
            if chunk is None:
                break
            yield chunk
    finally:
        task.cancel()
