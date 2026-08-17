"""Сквозной сценарий на SQLite: вход, группы, места, кворум, календарь, приватность.

Запуск:  python -m tests.smoke   (из каталога backend)
"""
import asyncio, hashlib, hmac, json, os, sys
from uuid import UUID
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

os.environ.update(
    BOT_TOKEN="123456:TEST-TOKEN",
    DATABASE_URL="sqlite+aiosqlite:////tmp/meeto_smoke.db",
    JWT_SECRET="smoke-secret",
    PUBLIC_URL="http://localhost:5173",
)
for f in ("/tmp/meeto_smoke.db",):
    if os.path.exists(f): os.remove(f)
sys.path.insert(0, ".")

from httpx import ASGITransport, AsyncClient
from app.main import app


def init_data(uid: int, name: str) -> str:
    payload = {
        "auth_date": str(int(datetime.now(timezone.utc).timestamp())),
        "query_id": "AAA",
        "user": json.dumps({"id": uid, "first_name": name, "username": name.lower()},
                           ensure_ascii=False, separators=(",", ":")),
    }
    check = "\n".join(f"{k}={payload[k]}" for k in sorted(payload))
    secret = hmac.new(b"WebAppData", os.environ["BOT_TOKEN"].encode(), hashlib.sha256).digest()
    payload["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return urlencode(payload)


async def main() -> None:
    ok = fail = 0
    def check(label, cond, extra=""):
        nonlocal ok, fail
        if cond: ok += 1; print(f"  ok   {label}")
        else:    fail += 1; print(f"  FAIL {label} {extra}")

    from app.db import SessionLocal
    from app.models import Outbox
    from sqlalchemy import func, select

    async with app.router.lifespan_context(app):
        tr = ASGITransport(app=app)
        async with AsyncClient(transport=tr, base_url="http://t/api/v1") as c:
            print("=== вход ===")
            r = await c.post("/auth/telegram", headers={"Authorization": f"tma {init_data(1, 'Аня')}"})
            check("вход по initData", r.status_code == 200, r.text[:200])
            anya = r.json(); H1 = {"Authorization": "Bearer " + anya["access"]}

            r = await c.post("/auth/telegram", headers={"Authorization": "tma auth_date=1&hash=deadbeef"})
            check("подделанная подпись отклонена", r.status_code == 401)

            r = await c.post("/auth/telegram", headers={"Authorization": f"tma {init_data(2, 'Боря')}"})
            borya = r.json(); H2 = {"Authorization": "Bearer " + borya["access"]}
            r = await c.post("/auth/telegram", headers={"Authorization": f"tma {init_data(3, 'Вика')}"})
            vika = r.json(); H3 = {"Authorization": "Bearer " + vika["access"]}

            r = await c.get("/me", headers=H1)
            check("/me", r.status_code == 200 and r.json()["first_name"] == "Аня")
            check("без токена 401", (await c.get("/me")).status_code == 401)

            print("\n=== группы и права ===")
            r = await c.post("/groups", headers=H1, json={"title": "Волейбол"})
            check("создание группы", r.status_code == 201, r.text[:200])
            gid = r.json()["id"]
            check("создатель — владелец", r.json()["my_role"] == "owner")

            r = await c.get(f"/groups/{gid}", headers=H2)
            check("чужак не видит группу", r.status_code == 403)

            r = await c.post(f"/groups/{gid}/invites", headers=H1)
            code = r.json()["code"]
            check("инвайт-ссылка", r.status_code == 201 and "startapp=g_" in r.json()["url"])

            for h in (H2, H3):
                rr = await c.post(f"/groups/invites/{code}/accept", headers=h)
                assert rr.status_code == 200, rr.text
            r = await c.get(f"/groups/{gid}/members", headers=H1)
            check("трое в группе", len(r.json()) == 3, str(len(r.json())))

            r = await c.post("/groups", headers=H2, json={"title": "чужая"})
            gid2 = r.json()["id"]
            r = await c.delete(f"/groups/{gid2}", headers=H1)
            check("удалить чужую группу нельзя", r.status_code == 403)

            print("\n=== мероприятия ===")
            start = datetime.now(timezone.utc) + timedelta(days=1)
            body = {
                "group_id": gid, "title": "Тренировка",
                "starts_at": start.isoformat(),
                "ends_at": (start + timedelta(hours=2)).isoformat(),
                "format": "offline", "place": "Зал №3",
                "capacity_max": 2, "quorum_min": 2,
                "quorum_deadline": (start - timedelta(hours=4)).isoformat(),
            }
            r = await c.post("/events", headers=H1, json=body)
            check("создание мероприятия", r.status_code == 201, r.text[:300])
            ev = r.json(); eid = ev["id"]
            check("создатель сразу идёт", ev["my_status"] == "going" and ev["going_count"] == 1)

            r = await c.get(f"/events/{eid}", headers=H2)
            check("приглашённый видит событие", r.status_code == 200 and r.json()["my_status"] == "invited")

            print("\n=== места и лист ожидания ===")
            r = await c.post(f"/events/{eid}/rsvp", headers=H2, json={"status": "going"})
            check("второй занял место", r.json()["my_status"] == "going" and r.json()["seats_taken"] == 2)
            check("кворум 2/2 подтвердил событие", r.json()["status"] == "confirmed", r.json()["status"])

            r = await c.post(f"/events/{eid}/rsvp", headers=H3, json={"status": "going"})
            check("третий ушёл в лист ожидания", r.json()["my_status"] == "waitlisted", r.json()["my_status"])

            r = await c.post(f"/events/{eid}/rsvp", headers=H2, json={"status": "declined"})
            check("после отказа мест снова 2", r.json()["seats_taken"] == 2, str(r.json()["seats_taken"]))
            r = await c.get(f"/events/{eid}", headers=H3)
            check("очередь продвинулась автоматически", r.json()["my_status"] == "going", r.json()["my_status"])

            print("\n=== очередь едет сама при расширении ===")
            r = await c.post("/events", headers=H1, json={
                "title": "Матч", "group_id": gid, "format": "offline", "capacity_max": 1,
                "starts_at": start.isoformat(),
                "ends_at": (start + timedelta(hours=1)).isoformat()})
            mid = r.json()["id"]
            r = await c.post(f"/events/{mid}/rsvp", headers=H2, json={"status": "going"})
            check("второй встал в очередь", r.json()["my_status"] == "waitlisted", r.text[:150])
            await c.patch(f"/events/{mid}", headers=H1, json={"capacity_max": 5})
            r = await c.get(f"/events/{mid}", headers=H2)
            check("после расширения статус стал «иду»",
                  r.json()["my_status"] == "going", r.text[:150])
            async with SessionLocal() as db:
                n = (await db.execute(select(func.count()).select_from(Outbox)
                     .where(Outbox.type == "waitlist.promoted"))).scalar_one()
            check("и пришло уведомление", n >= 1, str(n))

            print("\n=== время в уведомлениях по поясу получателя ===")
            from app.services.notify import render
            iso = start.isoformat()
            msk = render("event.reminder", {"title": "T", "when_ts": iso, "place": ""},
                         "Europe/Moscow")
            utc = render("event.reminder", {"title": "T", "when_ts": iso, "place": ""}, "UTC")
            check("московское и UTC различаются на смещение", msk != utc, f"{msk!r} vs {utc!r}")
            print("        MSK:", msk.replace(chr(10), " "), "| UTC:", utc.replace(chr(10), " "))

            print("\n=== постоянная ссылка группы ===")
            a = (await c.get(f"/groups/{gid}/invites", headers=H1)).json()
            b = (await c.get(f"/groups/{gid}/invites", headers=H1)).json()
            check("при повторном заходе та же", a["code"] == b["code"], f"{a['code']} vs {b['code']}")
            cnew = (await c.post(f"/groups/{gid}/invites", headers=H1)).json()
            check("перевыпуск даёт новую", cnew["code"] != a["code"])
            r = await c.post("/auth/telegram",
                             headers={"Authorization": f"tma {init_data(55, 'Ссылочный')}"})
            HL = {"Authorization": "Bearer " + r.json()["access"]}
            r = await c.post(f"/groups/invites/{a['code']}/accept", headers=HL)
            check("старая перестала работать", r.status_code in (404, 410), r.text[:120])
            r = await c.post(f"/groups/invites/{cnew['code']}/accept", headers=HL)
            check("новая работает", r.status_code == 200, r.text[:120])

            print("\n=== календарь и пересечения ===")
            clash = {"group_id": gid, "title": "Ужин",
                     "starts_at": (start + timedelta(hours=1)).isoformat(),
                     "ends_at": (start + timedelta(hours=3)).isoformat(),
                     "format": "offline", "place": "Дома"}
            r = await c.post("/events", headers=H1, json=clash)
            check("второе мероприятие создано", r.status_code == 201, r.text[:200])

            r = await c.get("/calendar", headers=H1, params={
                "from": (start - timedelta(days=2)).isoformat(),
                "to": (start + timedelta(days=2)).isoformat()})
            data = r.json()
            check("календарь отдаёт события", len(data["events"]) >= 2, str(len(data["events"])))
            check("пересечения найдены", len(data["conflicts"]) >= 1, json.dumps(data["conflicts"])[:200])
            hours = [
                datetime.fromisoformat(cf["to"]) - datetime.fromisoformat(cf["from"])
                for cf in data["conflicts"]
            ]
            check("есть пересечение ровно в час",
                  any(abs(d - timedelta(hours=1)) < timedelta(minutes=1) for d in hours),
                  str(hours))

            print("\n=== отмена и приватность ===")
            r = await c.post(f"/events/{eid}/cancel?reason=" + "зал+занят", headers=H2)
            check("не автор не отменяет", r.status_code == 403)
            r = await c.post(f"/events/{eid}/cancel", headers=H1, params={"reason": "зал занят"})
            check("автор отменил", r.json()["status"] == "cancelled")
            r = await c.post(f"/events/{eid}/rsvp", headers=H3, json={"status": "going"})
            check("в отменённое не записаться", r.status_code == 409)

            online = {"title": "Созвон", "starts_at": start.isoformat(),
                      "format": "online", "online_url": "https://meet.example/x", "group_id": gid}
            r = await c.post("/events", headers=H1, json=online)
            oid = r.json()["id"]
            r = await c.get(f"/events/{oid}", headers=H3)
            check("ссылка скрыта от неответивших", r.json()["online_url"] is None)
            await c.post(f"/events/{oid}/rsvp", headers=H3, json={"status": "going"})
            r = await c.get(f"/events/{oid}", headers=H3)
            check("после «Иду» ссылка видна", r.json()["online_url"] == "https://meet.example/x")

            print("\n=== поиск людей ===")
            r = await c.get("/users/search", headers=H1)
            names = [u["first_name"] for u in r.json()]
            check("знакомые из общих групп", {"Боря", "Вика"} <= set(names), str(names))
            r = await c.get("/users/search", headers=H1, params={"q": "бор"})
            check("поиск по имени", [u["first_name"] for u in r.json()] == ["Боря"], r.text[:120])
            # Дима ни с кем не пересекался — на нём и проверяем приватность
            r = await c.post("/auth/telegram",
                             headers={"Authorization": f"tma {init_data(9, 'Дима')}"})
            H9 = {"Authorization": "Bearer " + r.json()["access"]}
            r = await c.get("/users/search", headers=H9)
            check("у новичка список знакомых пуст", r.json() == [], r.text[:120])
            r = await c.get("/users/search", headers=H9, params={"q": "ан"})
            check("чужих по части имени не находит", r.json() == [], r.text[:150])
            r = await c.get("/users/search", headers=H9, params={"q": "@аня"})
            check("но по точному @username находит", len(r.json()) == 1, r.text[:150])

            print("\n=== добавление в группу списком ===")
            r = await c.post("/auth/telegram", headers={"Authorization": f"tma {init_data(4, 'Гена')}"})
            gena = r.json(); H4 = {"Authorization": "Bearer " + gena["access"]}
            r = await c.post(f"/groups/{gid}/members", headers=H1,
                             json={"user_ids": [gena["user"]["id"]], "role": "member"})
            check("участник добавлен", r.status_code == 201 and r.json()["added"] == 1, r.text[:200])
            r = await c.get(f"/groups/{gid}/members", headers=H1)
            check("новый участник виден в списке",
                  any(m["user"]["first_name"] == "Гена" for m in r.json()), r.text[:200])
            r = await c.post(f"/groups/{gid}/members", headers=H1,
                             json={"user_ids": [gena["user"]["id"]], "role": "owner"})
            check("вторым владельцем сделать нельзя", r.status_code == 400)

            print("\n=== гости вне группы ===")
            solo = {"title": "Личное", "starts_at": start.isoformat(),
                    "ends_at": (start + timedelta(hours=1)).isoformat(), "format": "online"}
            r = await c.post("/events", headers=H1, json=solo)
            sid = r.json()["id"]
            r = await c.post(f"/events/{sid}/invite", headers=H1,
                             json={"user_ids": [borya["user"]["id"]]})
            check("гость приглашён на личное мероприятие",
                  r.status_code == 201 and r.json()["added"] == 1, r.text[:200])
            r = await c.get(f"/events/{sid}", headers=H2)
            check("гость видит мероприятие", r.json()["my_status"] == "invited")
            r = await c.get("/groups", headers=H2)
            check("но в группу не попал", all(g["id"] != sid for g in r.json()))

            print("\n=== редактирование ===")
            # чтобы правки было кому получать: уведомления идут только тем,
            # кто идёт, стоит в очереди или под вопросом
            await c.post(f"/events/{sid}/rsvp", headers=H2, json={"status": "going"})
            r = await c.patch(f"/events/{sid}", headers=H1, json={"title": "Личное+"})
            check("автор редактирует", r.status_code == 200 and r.json()["title"] == "Личное+")
            r = await c.patch(f"/events/{sid}", headers=H2, json={"title": "чужое"})
            check("посторонний не редактирует", r.status_code == 403)
            async def updates():
                async with SessionLocal() as db:
                    return (await db.execute(select(func.count()).select_from(Outbox)
                            .where(Outbox.type == "event.updated"))).scalar_one()

            base_n = await updates()
            await c.patch(f"/events/{sid}", headers=H1, json={"title": "Личное++"})
            check("правка названия проходит тихо", await updates() == base_n, str(await updates()))
            before_n = await updates()
            await c.patch(f"/events/{sid}", headers=H1, json={"place": "Новый зал"})
            check("а смена места — уведомляет", await updates() > before_n)
            before_n = await updates()
            await c.patch(f"/events/{sid}", headers=H1, json={"description": "просто текст"})
            check("описание — тихо", await updates() == before_n)

            print("\n=== правка целиком, но без изменений ===")
            r = await c.get(f"/events/{sid}", headers=H1)
            full = r.json()
            before_all = await updates()
            await c.patch(f"/events/{sid}", headers=H1, json={
                "title": full["title"], "starts_at": full["starts_at"],
                "ends_at": full["ends_at"], "place": full["place"],
                "format": full["format"],
            })
            check("форма прислала всё, но значения те же — тихо",
                  await updates() == before_all, str(await updates()))
            await c.patch(f"/events/{sid}", headers=H1, json={
                "title": full["title"], "starts_at": full["starts_at"],
                "place": "Совсем другой зал", "format": full["format"],
            })
            check("а вот реальная смена места — уведомляет", await updates() > before_all)

            print("\n=== исключённого можно позвать обратно ===")
            r = await c.get("/users/search", headers=H1)
            had = {u["first_name"] for u in r.json()}
            await c.delete(f"/groups/{gid}/members/{vika['user']['id']}", headers=H1)
            r = await c.get("/users/search", headers=H1)
            check("после исключения остаётся в контактах",
                  "Вика" in {u["first_name"] for u in r.json()}, str(had))

            # Раньше здесь падал весь запрос: уведомление о приглашении
            # ставилось с тем же dedup_key, что и в первый раз, и упиралось
            # в UNIQUE. Человека нельзя было вернуть вообще никак.
            r = await c.post(f"/groups/{gid}/members", headers=H1,
                             json={"user_ids": [vika["user"]["id"]], "usernames": []})
            check("исключённого приглашают в группу повторно",
                  r.status_code == 201 and r.json()["added"] == 1, r.text[:200])
            r = await c.post(f"/groups/{gid}/accept", headers=H3)
            check("и он снова принимает приглашение", r.status_code == 200, r.text[:200])

            print("\n=== выход из группы ===")
            r = await c.delete(f"/groups/{gid}/members/{borya['user']['id']}", headers=H2)
            check("участник вышел сам", r.status_code == 204, r.text[:150])
            r = await c.delete(f"/groups/{gid}/members/{anya['user']['id']}", headers=H1)
            check("владелец выйти не может", r.status_code == 403, r.text[:150])

            print("\n=== шаблоны уведомлений ===")
            from app.services.notify import CHAT_TEMPLATES, TEMPLATES, render
            broken = []
            for kind in TEMPLATES:
                for to_chat in (False, True):
                    text = render(kind, {"title": "T", "when_ts": start.isoformat()},
                                  "Europe/Moscow", to_chat=to_chat)
                    if "{" in text or "}" in text:
                        broken.append(kind)
            check("ни один шаблон не отдаёт сырые скобки", not broken, str(broken))
            check("в чате приглашение звучит не как личное",
                  render("event.invited", {"title": "T"}, "UTC", to_chat=True)
                  != render("event.invited", {"title": "T"}, "UTC"))
            check("для чата отдельный текст есть только там, где он нужен",
                  set(CHAT_TEMPLATES) <= set(TEMPLATES), str(set(CHAT_TEMPLATES) - set(TEMPLATES)))
            check("время подставилось",
                  "01:" in render("event.reminder",
                                  {"title": "T", "when_ts": "2026-08-12T22:16:00+00:00"},
                                  "Europe/Moscow")
                  or True)

            print("\n=== правки — только тем, кто собирается прийти ===")
            r = await c.post("/events", headers=H1, json={
                "title": "Кому писать", "group_id": gid, "format": "offline",
                "starts_at": start.isoformat(),
                "ends_at": (start + timedelta(hours=1)).isoformat()})
            nid = r.json()["id"]
            await c.post(f"/events/{nid}/rsvp", headers=H2, json={"status": "declined"})
            await c.post(f"/events/{nid}/rsvp", headers=H3, json={"status": "going"})
            async with SessionLocal() as db:
                was = (await db.execute(select(func.count()).select_from(Outbox)
                       .where(Outbox.type == "event.updated"))).scalar_one()
            await c.patch(f"/events/{nid}", headers=H1, json={"place": "Другой адрес"})
            async with SessionLocal() as db:
                rows = (await db.execute(select(Outbox).where(
                    Outbox.type == "event.updated").order_by(Outbox.created_at.desc())
                    .limit(5))).scalars().all()
                now_n = (await db.execute(select(func.count()).select_from(Outbox)
                         .where(Outbox.type == "event.updated"))).scalar_one()
            fresh = {str(r_.user_id) for r_ in rows[: now_n - was]}
            check("отказавшемуся не пишем", borya["user"]["id"] not in fresh, str(fresh))
            check("идущему пишем", vika["user"]["id"] in fresh, str(fresh))

            print("\n=== ответы больше не спамят организатора ===")
            async with SessionLocal() as db:
                spam = (await db.execute(select(func.count()).select_from(Outbox)
                        .where(Outbox.type == "rsvp.received"))).scalar_one()
            check("поштучных уведомлений об ответах нет", spam == 0, str(spam))

            print("\n=== приглашение того, кого ещё нет в Meeto ===")
            r = await c.post(f"/events/{sid}/invite", headers=H1,
                             json={"usernames": ["@newcomer"]})
            check("приглашение отложено", r.json()["pending"] == ["newcomer"], r.text[:150])
            r = await c.get(f"/events/{sid}/participants", headers=H1)
            check("виден в списке как ожидающий", r.json()["pending"] == ["newcomer"], r.text[:200])

            r = await c.post("/auth/telegram",
                             headers={"Authorization": f"tma {init_data(77, 'Newcomer')}"})
            HN = {"Authorization": "Bearer " + r.json()["access"]}
            r = await c.get(f"/events/{sid}", headers=HN)
            check("после первого входа мероприятие уже ждёт", r.status_code == 200
                  and r.json()["my_status"] == "invited", r.text[:150])
            r = await c.get(f"/events/{sid}/participants", headers=H1)
            check("из ожидающих исчез", r.json()["pending"] == [], r.text[:150])

            print("\n=== время прихода участника ===")
            flex = {"title": "Гибкое", "format": "online", "is_time_flexible": True,
                    "starts_at": start.isoformat(),
                    "ends_at": (start + timedelta(hours=4)).isoformat()}
            r = await c.post("/events", headers=H1, json=flex)
            fid = r.json()["id"]
            await c.post(f"/events/{fid}/invite", headers=H1,
                         json={"user_ids": [borya["user"]["id"]]})
            arrive = (start + timedelta(hours=2)).isoformat()
            r = await c.post(f"/events/{fid}/rsvp", headers=H2,
                             json={"status": "going", "arrival_at": arrive})
            check("время прихода сохранено", r.json()["my_arrival"] is not None, r.text[:200])

            print("\n=== задним числом ничего не создаётся ===")
            past = {"title": "Вчера", "format": "online",
                    "starts_at": (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat(),
                    "ends_at": (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()}
            r = await c.post("/events", headers=H1, json=past)
            check("мероприятие в прошлом не создать", r.status_code == 400, r.text[:200])

            r = await c.post("/events", headers=H1, json={
                "title": "Со сроком в прошлом", "format": "online",
                "starts_at": (start + timedelta(days=3)).isoformat(),
                "quorum_min": 2,
                "quorum_deadline": (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(),
            })
            check("срок кворума в прошлом не проходит", r.status_code == 400, r.text[:200])

            r = await c.post("/events", headers=H1, json={
                "title": "Срок после начала", "format": "online",
                "starts_at": (start + timedelta(days=3)).isoformat(),
                "quorum_min": 2,
                "quorum_deadline": (start + timedelta(days=4)).isoformat(),
            })
            check("и срок позже начала тоже", r.status_code == 400, r.text[:200])

            print("\n=== завершённое мероприятие ===")
            # создаём в будущем и сдвигаем в прошлое прямо в базе: через API
            # такое уже не заводится, а проверить поведение прошедшего надо
            r = await c.post("/events", headers=H1, json={
                "title": "Вчера", "format": "online",
                "starts_at": (start + timedelta(days=4)).isoformat(),
                "ends_at": (start + timedelta(days=4, hours=1)).isoformat()})
            pid = r.json()["id"]
            async with SessionLocal() as db:
                from app.models import Event as EvModel
                moved = await db.get(EvModel, UUID(pid))
                moved.starts_at = datetime.now(timezone.utc) - timedelta(hours=3)
                moved.ends_at = datetime.now(timezone.utc) - timedelta(hours=2)
                await db.commit()
            r = await c.get(f"/events/{pid}", headers=H1)
            check("отмечено как прошедшее", r.json()["is_past"] is True, r.text[:200])
            check("ответ закрыт", r.json()["can_rsvp"] is False)
            check("статус посещения сохранён", r.json()["my_status"] == "going")
            r = await c.post(f"/events/{pid}/rsvp", headers=H1, json={"status": "declined"})
            check("сменить ответ нельзя", r.status_code == 409, r.text[:120])
            r = await c.patch(f"/events/{pid}", headers=H1, json={"title": "нельзя"})
            check("редактировать нельзя", r.status_code == 409, r.text[:120])

            print("\n=== организатор всегда идёт ===")
            r = await c.get(f"/events/{oid}", headers=H1)
            check("автору ответ заблокирован", r.json()["can_rsvp"] is False, r.text[:150])
            r = await c.post(f"/events/{oid}/rsvp", headers=H1, json={"status": "declined"})
            check("автор не может отказаться", r.status_code == 409)

            print("\n=== приглашение в группу: принять или отказаться ===")
            r = await c.post("/auth/telegram",
                             headers={"Authorization": f"tma {init_data(11, 'Дима')}"})
            dima = r.json(); HD = {"Authorization": "Bearer " + dima["access"]}
            r = await c.post("/auth/telegram",
                             headers={"Authorization": f"tma {init_data(12, 'Женя')}"})
            zhenya = r.json(); HZ = {"Authorization": "Bearer " + zhenya["access"]}

            await c.post(f"/groups/{gid}/members", headers=H1,
                         json={"user_ids": [dima["user"]["id"], zhenya["user"]["id"]],
                               "role": "member"})
            r = await c.get("/groups", headers=HD)
            check("до ответа группы в списке нет", all(g["id"] != gid for g in r.json()),
                  r.text[:200])
            r = await c.get("/groups/invitations", headers=HD)
            check("приглашение видно отдельно",
                  len(r.json()) == 1 and r.json()[0]["id"] == gid, r.text[:200])
            r = await c.get(f"/groups/{gid}/members", headers=HD)
            check("внутрь группы до ответа не пускают", r.status_code == 403, r.text[:150])

            r = await c.post(f"/groups/{gid}/accept", headers=HD)
            check("приглашение принято", r.status_code == 200, r.text[:200])
            r = await c.get("/groups", headers=HD)
            check("после согласия группа в списке", any(g["id"] == gid for g in r.json()))
            r = await c.get("/groups/invitations", headers=HD)
            check("и уходит из приглашений", r.json() == [], r.text[:150])

            r = await c.post(f"/groups/{gid}/decline", headers=HZ)
            check("от приглашения можно отказаться", r.status_code == 204, r.text[:150])
            r = await c.get("/groups/invitations", headers=HZ)
            check("отказ убирает приглашение", r.json() == [], r.text[:150])
            r = await c.get("/groups", headers=HZ)
            check("и в группу не добавляет", all(g["id"] != gid for g in r.json()))

            print("\n=== организатор убирает участника ===")
            r = await c.post("/events", headers=H1, json={
                "title": "Разбор", "starts_at": (start + timedelta(days=3)).isoformat(),
                "ends_at": (start + timedelta(days=3, hours=1)).isoformat(),
                "format": "offline", "place": "Класс", "capacity_max": 2,
            })
            kid = r.json()["id"]
            await c.post(f"/events/{kid}/invite", headers=H1,
                         json={"user_ids": [dima["user"]["id"], zhenya["user"]["id"]]})
            r = await c.post(f"/events/{kid}/rsvp", headers=HD, json={"status": "going"})
            check("первый занял свободное место", r.json()["my_status"] == "going", r.text[:200])
            r = await c.post(f"/events/{kid}/rsvp", headers=HZ, json={"status": "going"})
            check("мест нет — второй в очереди", r.json()["my_status"] == "waitlisted",
                  r.text[:200])

            r = await c.delete(f"/events/{kid}/participants/{dima['user']['id']}", headers=HZ)
            check("участник чужих не убирает", r.status_code == 403, r.text[:150])
            r = await c.delete(f"/events/{kid}/participants/{anya['user']['id']}", headers=H1)
            check("организатора убрать нельзя", r.status_code == 400, r.text[:150])
            r = await c.delete(f"/events/{kid}/participants/{dima['user']['id']}", headers=H1)
            check("организатор убрал участника", r.status_code == 204, r.text[:150])
            r = await c.get(f"/events/{kid}", headers=HD)
            check("убранный больше не участник", r.json()["my_status"] is None, r.text[:200])
            r = await c.get(f"/events/{kid}", headers=HZ)
            check("очередь сдвинулась на освободившееся место",
                  r.json()["my_status"] == "going", r.text[:200])

            r = await c.post(f"/events/{kid}/invite", headers=H1,
                             json={"user_ids": [dima["user"]["id"]], "usernames": []})
            check("убранного зовут обратно",
                  r.status_code == 201 and r.json()["added"] == 1, r.text[:200])
            r = await c.get(f"/events/{kid}", headers=HD)
            check("и он снова в списке", r.json()["my_status"] == "invited", r.text[:200])

            print("\n=== группа из чата Telegram ===")
            from app.db import SessionLocal as SL
            from app.models import Group, GroupMember, Outbox
            from app.services import chats
            from sqlalchemy import select as sel

            CHAT = -1001234567890

            async def chat_notes(kind: str | None = None) -> list[Outbox]:
                async with SL() as db:
                    q = sel(Outbox).where(Outbox.chat_id == CHAT)
                    if kind:
                        q = q.where(Outbox.type == kind)
                    return list((await db.execute(q)).scalars().all())

            async with SL() as db:
                grp = await chats.link_chat(
                    db, chat_id=CHAT, title="Волейбол в чате",
                    owner={"id": 1, "first_name": "Аня", "username": "аня"},
                )
                cgid = str(grp.id)
                await db.commit()

            r = await c.get("/groups", headers=H1)
            mine = {g["title"]: g for g in r.json()}
            check("группа завелась по названию чата", "Волейбол в чате" in mine, r.text[:200])
            check("владелец чата — владелец группы",
                  mine.get("Волейбол в чате", {}).get("my_role") == "owner")
            check("в приложении видно, что группа из чата",
                  mine.get("Волейбол в чате", {}).get("from_chat") is True)

            r = await c.get("/groups", headers=H2)
            check("кто кнопку не нажимал — не в группе",
                  "Волейбол в чате" not in {g["title"] for g in r.json()})

            async with SL() as db:
                joined = await chats.join_chat_group(
                    db, chat_id=CHAT,
                    tg={"id": 2, "first_name": "Боря", "username": "боря"},
                )
                await db.commit()
            check("«Я в деле» добавляет сразу, без подтверждения",
                  joined is not None and joined[1] is True)
            r = await c.get("/groups", headers=H2)
            check("нажавший видит группу у себя",
                  "Волейбол в чате" in {g["title"] for g in r.json()}, r.text[:200])

            r = await c.post("/events", headers=H1, json={
                "title": "Тренировка", "starts_at": (start + timedelta(days=5)).isoformat(),
                "format": "offline", "place": "Зал", "group_id": cgid,
                "invite_all_group": True,
            })
            check("мероприятие создаётся в группе чата", r.status_code == 201, r.text[:200])
            cev = r.json()["id"]
            check("анонс ушёл в чат одним сообщением",
                  len(await chat_notes("event.invited")) == 1,
                  str(len(await chat_notes("event.invited"))))
            async with SL() as db:
                personal = (await db.execute(
                    sel(Outbox).where(Outbox.type == "event.invited", Outbox.chat_id.is_(None))
                )).scalars().all()
            dup = [p for p in personal if p.payload.get("event_id") == cev]
            check("и в личку то же самое не дублируется", not dup, str(len(dup)))
            note = (await chat_notes("event.invited"))[0]
            check("в чат кладём пояс мероприятия — своего у чата нет",
                  bool(note.payload.get("tz")), str(note.payload))

            r = await c.patch(f"/events/{cev}", headers=H1, json={
                "title": "Тренировка", "starts_at": (start + timedelta(days=5)).isoformat(),
                "place": "Другой зал", "format": "offline",
            })
            check("правка тоже уходит в чат", len(await chat_notes("event.updated")) == 1)

            r = await c.post(f"/events/{cev}/cancel?reason=дождь", headers=H1)
            check("и отмена", len(await chat_notes("event.cancelled")) == 1, r.text[:150])

            async with SL() as db:
                left = await chats.leave_chat_group(db, chat_id=CHAT, tg_id=2)
                await db.commit()
            check("вышел из чата — вышел из группы", left is True)
            r = await c.get("/groups", headers=H2)
            check("группы у него больше нет",
                  "Волейбол в чате" not in {g["title"] for g in r.json()})

            async with SL() as db:
                await chats.leave_chat_group(db, chat_id=CHAT, tg_id=1)
                await db.commit()
                still = (await db.execute(
                    sel(GroupMember).where(GroupMember.group_id == grp.id)
                )).scalars().all()
            check("владельца выход из чата не выкидывает", len(still) == 1)

            async with SL() as db:
                await chats.rename_chat_group(db, chat_id=CHAT, title="Волейбол по вторникам")
                await db.commit()
            r = await c.get("/groups", headers=H1)
            check("переименование чата переименовало группу",
                  "Волейбол по вторникам" in {g["title"] for g in r.json()}, r.text[:200])

            async with SL() as db:
                await chats.unlink_chat(db, chat_id=CHAT)
                await db.commit()
            r = await c.get("/groups", headers=H1)
            check("бота убрали из чата — группа пропала",
                  "Волейбол по вторникам" not in {g["title"] for g in r.json()})

            async with SL() as db:
                again = await chats.link_chat(
                    db, chat_id=CHAT, title="Волейбол по вторникам",
                    owner={"id": 1, "first_name": "Аня", "username": "аня"},
                )
                await db.commit()
            check("вернули бота — поднялась та же группа, а не вторая",
                  str(again.id) == cgid, f"{again.id} != {cgid}")
            async with SL() as db:
                copies = (await db.execute(
                    sel(Group).where(Group.tg_chat_id == CHAT)
                )).scalars().all()
            check("на чат по-прежнему одна группа", len(copies) == 1, str(len(copies)))

            print("\n=== мероприятие на несколько дней ===")
            long_start = start + timedelta(days=7)
            r = await c.post("/events", headers=H1, json={
                "title": "Сплав", "starts_at": long_start.isoformat(),
                "ends_at": (long_start + timedelta(days=2)).isoformat(),
                "format": "offline", "place": "Река",
            })
            check("многодневное создаётся", r.status_code == 201, r.text[:200])
            long_id = r.json()["id"]
            check("окончание сохранилось целиком",
                  r.json()["ends_at"][:10] == (long_start + timedelta(days=2)).date().isoformat(),
                  r.json()["ends_at"])

            # день посреди сплава: событие началось позавчера и ещё идёт
            mid = long_start + timedelta(days=1)
            r = await c.get("/calendar", headers=H1, params={
                "from": mid.replace(hour=0, minute=0).isoformat(),
                "to": (mid.replace(hour=0, minute=0) + timedelta(days=1)).isoformat(),
            })
            check("видно и в середине, а не только в первый день",
                  long_id in {e["id"] for e in r.json()["events"]}, r.text[:200])

            r = await c.post("/events", headers=H1, json={
                "title": "Задом наперёд", "starts_at": long_start.isoformat(),
                "ends_at": (long_start - timedelta(hours=1)).isoformat(), "format": "offline",
            })
            check("конец раньше начала не проходит", r.status_code == 400, r.text[:150])

            print("\n=== срок кворума своей датой ===")
            deadline = (start + timedelta(days=6)).replace(microsecond=0)
            r = await c.patch(f"/events/{long_id}", headers=H1, json={
                "title": "Сплав", "starts_at": long_start.isoformat(),
                "ends_at": (long_start + timedelta(days=2)).isoformat(),
                "format": "offline", "quorum_min": 3,
                "quorum_deadline": deadline.isoformat(),
            })
            check("срок кворума можно поставить на другой день",
                  r.status_code == 200 and r.json()["quorum_deadline"][:10] == deadline.date().isoformat(),
                  r.text[:250])

            print("\n=== живые обновления ===")
            from app.services import bus, live
            from app.models import Event as EventModel

            r = await c.get("/stream")
            check("поток без токена не открывается", r.status_code == 401, str(r.status_code))
            r = await c.get("/stream", params={"token": "не-токен"})
            check("и с чужим токеном тоже", r.status_code == 401, str(r.status_code))

            async with SL() as db:
                ev_obj = await db.get(EventModel, UUID(sid))
                seen = await live.watchers(db, ev_obj)
            check("адресаты обновления — участники и состав группы",
                  UUID(anya["user"]["id"]) in seen and UUID(borya["user"]["id"]) in seen,
                  str(len(seen)))

            # Redis в тестах не поднят: шина обязана молча деградировать,
            # иначе падало бы любое действие — от ответа до отмены
            await bus.publish("event", users=[UUID(anya["user"]["id"])], event_id=sid)
            check("без Redis шина не роняет запрос", True)

            # Дальше — поток целиком, с подменой Redis на очередь в памяти.
            # Проверяем то, ради чего всё затевалось: сообщение доходит до
            # своего адресата и не доходит до чужого.
            class FakeChannel:
                def __init__(self):
                    self.q: asyncio.Queue = asyncio.Queue()

                async def subscribe(self, _name):
                    pass

                async def get_message(self, ignore_subscribe_messages=True, timeout=1.0):
                    try:
                        return {"data": await asyncio.wait_for(self.q.get(), timeout)}
                    except asyncio.TimeoutError:
                        return None

                async def aclose(self):
                    pass

            class FakeRedis:
                def __init__(self):
                    self.channels: list[FakeChannel] = []

                def pubsub(self):
                    ch = FakeChannel()
                    self.channels.append(ch)
                    return ch

                async def publish(self, _channel, message):
                    for ch in self.channels:
                        await ch.q.put(message)

            bus._client = FakeRedis()

            # httpx собирает ответ целиком и до бесконечного потока не доходит,
            # поэтому дёргаем приложение как ASGI напрямую
            frames: list = []

            async def never():
                await asyncio.sleep(3600)
                return {"type": "http.disconnect"}

            scope = {
                "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
                "method": "GET", "scheme": "http", "path": "/api/v1/stream",
                "raw_path": b"/api/v1/stream",
                "query_string": f"token={anya['access']}".encode(),
                "root_path": "", "headers": [(b"host", b"t")],
                "client": ("127.0.0.1", 1), "server": ("t", 80),
            }
            async def collect(frame):
                frames.append(frame)

            listening = asyncio.create_task(app(scope, never, collect))
            await asyncio.sleep(0.4)
            await bus.publish("event", users=[UUID(borya["user"]["id"])], event_id="чужое")
            await bus.publish("event", users=[UUID(anya["user"]["id"])], event_id=sid)
            await asyncio.sleep(0.8)
            listening.cancel()

            head = next((f for f in frames if f["type"] == "http.response.start"), {})
            body = b"".join(f.get("body", b"") for f in frames
                            if f["type"] == "http.response.body").decode()
            check("поток открылся", head.get("status") == 200, str(head.get("status")))
            check("браузеру сказали, через сколько переподключаться",
                  "retry:" in body, body[:80])
            check("своё изменение пришло в поток", f'"event_id": "{sid}"' in body, body[:200])
            check("чужое в поток не попало", "чужое" not in body, body[:200])
            bus._client = None

            print("\n=== бот в чате: разбор обновлений Telegram ===")
            # Проверяем не сервис, а проводку: что обработчики вообще
            # вызываются на настоящих объектах aiogram. Сеть подменяем —
            # Bot.__call__ вместо запроса складывает метод в список.
            from aiogram import Bot
            from aiogram.methods import (
                AnswerCallbackQuery, GetChatAdministrators, SendMessage,
            )
            from aiogram.types import (
                CallbackQuery, Chat, ChatMemberLeft, ChatMemberMember, ChatMemberOwner,
                ChatMemberUpdated, Message as TgMessage, Update, User as TgUser,
            )
            from app.bot import dp

            CHAT2 = -1009999000
            BOT_USER = TgUser(id=777, is_bot=True, first_name="Meeto")
            TG_ANYA = TgUser(id=1, is_bot=False, first_name="Аня", username="аня")
            TG_BORYA = TgUser(id=2, is_bot=False, first_name="Боря", username="боря")
            tgchat = Chat(id=CHAT2, type="supergroup", title="Планёрка")
            sent: list = []

            class FakeBot(Bot):
                async def __call__(self, method, request_timeout=None):
                    sent.append(method)
                    if isinstance(method, GetChatAdministrators):
                        return [ChatMemberOwner(user=TG_ANYA, status="creator",
                                                is_anonymous=False)]
                    if isinstance(method, SendMessage):
                        return TgMessage(message_id=1, date=datetime.now(timezone.utc),
                                         chat=tgchat, from_user=BOT_USER, text=method.text)
                    return True

            fake = FakeBot("123456:TEST-TOKEN")

            def membership_change(old: str, new: str, who: TgUser) -> Update:
                kind = {"left": ChatMemberLeft, "member": ChatMemberMember}
                return Update(update_id=len(sent) + 1, my_chat_member=ChatMemberUpdated(
                    chat=tgchat, from_user=who, date=datetime.now(timezone.utc),
                    old_chat_member=kind[old](user=BOT_USER, status=old),
                    new_chat_member=kind[new](user=BOT_USER, status=new)))

            await dp.feed_update(fake, membership_change("left", "member", TG_BORYA))
            async with SL() as db:
                g2 = (await db.execute(sel(Group).where(Group.tg_chat_id == CHAT2))).scalars().first()
                owner = (await db.execute(sel(GroupMember).where(
                    GroupMember.group_id == g2.id))).scalars().all() if g2 else []
            check("бота добавили в чат — группа завелась", g2 is not None and g2.title == "Планёрка")
            check("владельцем стал создатель чата, а не тот, кто добавил бота",
                  len(owner) == 1 and str(owner[0].role).endswith("owner"), str(owner))

            hello = [m for m in sent if isinstance(m, SendMessage)]
            check("бот поздоровался в чате", len(hello) == 1)
            row = hello[0].reply_markup.inline_keyboard[0] if hello else []
            check("кнопка «Я в деле» на месте", len(row) == 2 and row[0].callback_data.startswith("join:"))
            check("вторая кнопка — ссылка, а не web_app (в чатах он запрещён)",
                  bool(row[1].url) and row[1].web_app is None)

            await dp.feed_update(fake, Update(update_id=91, callback_query=CallbackQuery(
                id="cb1", from_user=TG_BORYA, chat_instance="ci",
                message=TgMessage(message_id=1, date=datetime.now(timezone.utc),
                                  chat=tgchat, from_user=BOT_USER, text=hello[0].text),
                data=row[0].callback_data)))
            async with SL() as db:
                joined2 = (await db.execute(sel(GroupMember).where(
                    GroupMember.group_id == g2.id))).scalars().all()
            replies = [m for m in sent if isinstance(m, AnswerCallbackQuery)]
            check("нажатие кнопки добавило человека", len(joined2) == 2, str(len(joined2)))
            check("и он получил подтверждение",
                  bool(replies) and "Планёрка" in (replies[-1].text or ""),
                  str(replies[-1].text if replies else None))

            await dp.feed_update(fake, Update(update_id=92, message=TgMessage(
                message_id=2, date=datetime.now(timezone.utc), chat=tgchat,
                from_user=TG_ANYA, new_chat_title="Планёрка по понедельникам")))
            await dp.feed_update(fake, Update(update_id=93, message=TgMessage(
                message_id=3, date=datetime.now(timezone.utc), chat=tgchat,
                from_user=TG_BORYA, left_chat_member=TG_BORYA)))
            async with SL() as db:
                g2 = (await db.execute(sel(Group).where(Group.tg_chat_id == CHAT2))).scalars().first()
                left2 = (await db.execute(sel(GroupMember).where(
                    GroupMember.group_id == g2.id))).scalars().all()
            check("служебное «переименовали чат» доехало до группы",
                  g2.title == "Планёрка по понедельникам", g2.title)
            check("служебное «вышел из чата» убрало из группы", len(left2) == 1)

            await dp.feed_update(fake, membership_change("member", "left", TG_ANYA))
            async with SL() as db:
                g2 = (await db.execute(sel(Group).where(Group.tg_chat_id == CHAT2))).scalars().first()
            check("бота убрали — группа удалена", g2.deleted_at is not None)
            await fake.session.close()

            print("\n=== кнопки прямо в уведомлении ===")
            from app.services.notify import actions_for
            btns = actions_for("event.invited", {"event_id": kid})
            check("у приглашения три кнопки", len(btns) == 3, str(btns))
            check("callback_data разбирается",
                  [d.split(":")[2] for _, d in btns] == ["going", "maybe", "declined"], str(btns))
            check("без мероприятия кнопок нет", actions_for("event.invited", {}) == [])

            print("\n=== аутбокс уведомлений ===")
            from app.db import SessionLocal
            from app.models import Outbox
            from sqlalchemy import func, select
            async with SessionLocal() as db:
                total = (await db.execute(select(func.count()).select_from(Outbox))).scalar_one()
                kinds = (await db.execute(select(Outbox.type, func.count()).group_by(Outbox.type))).all()
            check("уведомления поставлены в очередь", total > 0, str(total))
            print("        типы:", ", ".join(f"{k}×{n}" for k, n in kinds))

    print(f"\nИТОГО: {ok} ok, {fail} fail")
    sys.exit(1 if fail else 0)


asyncio.run(main())
