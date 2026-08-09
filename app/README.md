# Meeto

Telegram-бот и mini-app для организации мероприятий: календарь, приглашения,
лимит мест с листом ожидания и кворум с автоотменой.

Спецификация — `../SPEC.md`, эталон вёрстки — `../calendar-prototype.html`.

## Что уже работает

| Возможность | Где |
|---|---|
| Вход по `initData` с проверкой подписи, JWT + refresh | `backend/app/security.py` |
| Группы, роли и гранулярные права, инвайт-ссылки | `backend/app/api/groups.py` |
| Мероприятия, лимит мест, лист ожидания, кворум | `backend/app/services/events.py` |
| Календарь с расчётом пересечений | `backend/app/api/calendar.py` |
| Уведомления через транзакционный аутбокс | `backend/app/services/notify.py` |
| Бот с deep-link и `/today`, `/week` | `backend/app/bot.py` |
| Напоминания и разрешение кворума по расписанию | `backend/app/worker.py` |
| Mini-app: месяц / день / список, карточка, визард | `miniapp/src` |

## Развёртывание

**Разворачиваете впервые или с чистого сервера — откройте [DEPLOY.md](DEPLOY.md).**
Там пошагово: покупка VPS, SSH с Windows, фаервол, Docker, DNS, сертификат,
настройка BotFather, бэкапы и разбор типичных ошибок.

Ниже — краткая выжимка для тех, у кого сервер уже настроен.

### 1. Бот в BotFather

1. `/newbot` — получите токен.
2. `/mybots` → ваш бот → **Bot Settings → Menu Button → Configure menu button** →
   укажите URL `https://ваш-домен` и подпись «Открыть Meeto».
3. Там же **Configure Mini App** → тот же URL. Без этого `startapp`-ссылки не работают.
4. Домен обязан быть на HTTPS — Telegram не открывает mini-app по http.

### 2. Переменные

```bash
cp .env.example .env
python3 -c "import secrets; print(secrets.token_urlsafe(48))"   # в JWT_SECRET
```

Заполните `BOT_TOKEN`, `BOT_USERNAME`, `PUBLIC_URL` и пароль базы.

### 3. Сертификат и запуск

```bash
chmod +x scripts/*.sh
./scripts/init-cert.sh            # первый сертификат, порт 80 должен быть свободен
docker compose up -d --build
docker compose logs -f api bot worker
```

Дальше сертификат продлевается сам: контейнер `certbot` проверяет каждые
12 часов, nginx перечитывает конфиг каждые 6.

Проверка: `curl https://ваш-домен/api/v1/health` → `{"status":"ok"}`.

### 4. Разработка без Docker

```bash
# бэкенд
cd backend && pip install -r requirements.txt
DATABASE_URL=sqlite+aiosqlite:///./dev.db uvicorn app.main:app --reload

# фронт
cd miniapp && npm install && npm run dev
```

В обычном браузере вход не сработает: `initData` подписывает Telegram.
Для отладки UI откройте mini-app через бота на телефоне или в Telegram Desktop.

## Тесты

```bash
cd backend && python -m tests.smoke
```

Сквозной сценарий на SQLite: подпись initData, роли, овербукинг,
лист ожидания, кворум, пересечения, приватность ссылки на созвон, аутбокс.

## Архитектурные решения

**Лимит мест.** RSVP выполняется под `SELECT ... FOR UPDATE` на строке события.
Без этого два одновременных «Иду» на последнее место дают овербукинг.

**Уведомления.** Пишутся в таблицу `notifications_outbox` в той же транзакции,
что и само действие, — воркер разбирает очередь отдельно. Так уведомление не
уйдёт, если транзакция откатилась, и не потеряется при падении бота.
Дедупликация по `dedup_key`, ретраи с экспоненциальной задержкой, учёт `429`.

**Пересечения.** Sweep line по принятым мероприятиям, O(n log n). Гибкое время
участника сужает интервал, поэтому конфликт считается по реальному присутствию.

**Приватность.** `online_url` отдаётся только тем, кто ответил «Иду», и автору.

**Схема БД.** Для MVP создаётся из моделей при старте. Перед первыми реальными
пользователями переходите на Alembic: `alembic init migrations`,
`alembic revision --autogenerate -m "init"` — дальше только миграции.

## Что дальше (этап 2 по спецификации)

Чек-листы требований с уведомлением владельца, редактирование мероприятия из
mini-app, настройки уведомлений и тихие часы, чат групп и мероприятий,
повторяющиеся мероприятия, экспорт в `.ics`.
