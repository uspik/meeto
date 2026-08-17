import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import auth, calendar, events, groups, me, stream, users
from .config import settings
from .db import init_db

logging.basicConfig(level=settings.log_level)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    yield


app = FastAPI(title="Meeto API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.webapp_url, "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for router in (auth.router, me.router, users.router, groups.router,
               events.router, calendar.router, stream.router):
    app.include_router(router, prefix="/api/v1")


@app.get("/api/v1/health")
async def health():
    return {"status": "ok"}
