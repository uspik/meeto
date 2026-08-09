from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    bot_token: str = ""
    bot_username: str = "MeetoBot"
    public_url: str = "http://localhost:5173"

    jwt_secret: str = "dev-secret"
    access_ttl_min: int = 15
    refresh_ttl_days: int = 30
    initdata_ttl: int = 86400

    database_url: str = "postgresql+asyncpg://meeto:meeto@db:5432/meeto"
    redis_url: str = "redis://redis:6379/0"

    default_tz: str = "Europe/Moscow"
    log_level: str = "INFO"

    @property
    def webapp_url(self) -> str:
        return self.public_url.rstrip("/")


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
