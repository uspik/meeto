"""Шина живых обновлений.

Задача узкая: сказать открытым вкладкам «вот это изменилось», чтобы они
перезапросили ровно то, что показывают. Сами данные по шине не ездят —
только адрес изменения. Так проще: не надо повторять на клиенте логику
прав и видимости, а гонка «пришло старое состояние поверх нового»
исчезает сама, потому что клиент всегда берёт свежее через обычный API.

Публикуют все три процесса: api (ответы из приложения), bot (ответы
кнопками в Telegram) и worker (кворум, автоотмена). Поэтому шина —
Redis pub/sub: внутрипроцессной очереди хватило бы только для api.
Если Redis недоступен, приложение продолжает работать — просто без
живых обновлений, клиент переспросит данные сам при возврате на экран.
"""

import asyncio
import json
import logging
from typing import AsyncIterator, Iterable
from uuid import UUID

import redis.asyncio as aioredis

from ..config import settings

log = logging.getLogger("meeto.bus")

CHANNEL = "meeto:changes"

_client: aioredis.Redis | None = None


def client() -> aioredis.Redis:
    global _client
    if _client is None:
        _client = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _client


async def publish(kind: str, *, users: Iterable[UUID], **fields) -> None:
    """Сообщить перечисленным людям, что что-то поменялось.

    Адресаты считаются на сервере: кто участвует в мероприятии, кто состоит
    в группе. Клиент получает только те события, которые ему видны.
    """
    targets = sorted({str(u) for u in users if u})
    if not targets:
        return
    message = json.dumps({"kind": kind, "users": targets, **fields}, ensure_ascii=False)
    try:
        await client().publish(CHANNEL, message)
    except Exception as exc:  # noqa: BLE001
        # живые обновления — удобство, а не обязательство: молча продолжаем
        log.warning("шина недоступна, обновление не разослано: %s", exc)


async def listen(user_id: UUID) -> AsyncIterator[dict]:
    """Поток изменений для одного человека."""
    conn = client().pubsub()
    await conn.subscribe(CHANNEL)
    mine = str(user_id)
    try:
        while True:
            raw = await conn.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if raw is None:
                await asyncio.sleep(0)  # даём циклу выдохнуть
                continue
            try:
                data = json.loads(raw["data"])
            except (TypeError, ValueError):
                continue
            if mine in data.get("users", []):
                yield {k: v for k, v in data.items() if k != "users"}
    finally:
        await conn.aclose()
