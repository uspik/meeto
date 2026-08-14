"""Мостик до Alembic.

Схема пока создаётся из моделей, а `create_all` умеет добавлять только
недостающие таблицы — новые колонки в существующих он не трогает. Здесь
лежат идемпотентные доработки, которые нужно применить к уже работающей базе.

Когда появятся первые настоящие пользователи, схему надо заморозить и перейти
на Alembic; этот файл тогда удаляется.
"""

import logging

from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import AsyncConnection

log = logging.getLogger("meeto.migrate")

# таблица -> колонка -> определение
ADDITIONS: dict[str, dict[str, str]] = {
    "group_members": {
        "state": "VARCHAR(16) NOT NULL DEFAULT 'active'",
    },
}


async def ensure_schema(conn: AsyncConnection) -> None:
    tables = await conn.run_sync(lambda c: set(inspect(c).get_table_names()))

    for table, columns in ADDITIONS.items():
        if table not in tables:
            continue  # create_all уже создал её целиком
        present = await conn.run_sync(
            lambda c, t=table: {col["name"] for col in inspect(c).get_columns(t)}
        )
        for column, ddl in columns.items():
            if column in present:
                continue
            await conn.execute(text(f'ALTER TABLE {table} ADD COLUMN {column} {ddl}'))
            log.warning("добавлена колонка %s.%s", table, column)
