"""Сквозной сценарий на SQLite: вход, группы, места, кворум, календарь, приватность.

Запуск:  python -m tests.smoke   (из каталога backend)
"""
import asyncio, hashlib, hmac, json, os, sys
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
            check("календарь отдаёт события", len(data["events"]) == 2, str(len(data["events"])))
            check("пересечение найдено", len(data["conflicts"]) == 1, json.dumps(data["conflicts"])[:200])
            if data["conflicts"]:
                cf = data["conflicts"][0]
                dur = (datetime.fromisoformat(cf["to"]) - datetime.fromisoformat(cf["from"]))
                check("окно пересечения 1 час", abs(dur - timedelta(hours=1)) < timedelta(minutes=1), str(dur))

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
