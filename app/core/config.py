"""Application settings, read from environment variables and an optional .env file."""
import logging
import secrets
from pathlib import Path
from typing import List, Optional

from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[2]
_log = logging.getLogger("venteda.config")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=PROJECT_ROOT / ".env", extra="ignore")

    APP_NAME: str = "Venteda Chat"
    APP_VERSION: str = "2.0.0"
    DEBUG: bool = False

    # Security. Set SECRET_KEY in .env. If empty, a random key is generated per process.
    SECRET_KEY: str = ""
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7

    # Server
    HOST: str = "0.0.0.0"
    # Set COOKIE_SECURE=true when serving over HTTPS (required in production)
    COOKIE_SECURE: bool = False
    PORT: int = 3000

    # Database (SQLite file inside the project folder unless overridden)
    DATABASE_URL: str = f"sqlite:///{(PROJECT_ROOT / 'venteda.db').as_posix()}"

    # Uploads
    UPLOAD_DIR: str = str(PROJECT_ROOT / "uploads")
    MAX_UPLOAD_SIZE_BYTES: int = 25 * 1024 * 1024
    MAX_VOICE_SIZE_BYTES: int = 15 * 1024 * 1024

    # WebRTC ICE servers
    STUN_SERVER: str = "stun:stun.l.google.com:19302"
    TURN_SERVER: Optional[str] = None
    TURN_USERNAME: Optional[str] = None
    TURN_CREDENTIAL: Optional[str] = None

    # CORS: explicit origins only. Never "*".
    # Override in .env as a JSON list, e.g. CORS_ORIGINS=["https://chat.example.com"]
    CORS_ORIGINS: List[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]

    # Demo accounts: development only, off by default
    SEED_DEMO_USERS: bool = False
    DEMO_PASSWORD: str = ""


settings = Settings()

if not settings.SECRET_KEY:
    if not settings.DEBUG:
        # Production must not run with a key that changes on every restart.
        raise RuntimeError(
            "SECRET_KEY is not set. Refusing to start. Generate one with "
            "python -c \"import secrets; print(secrets.token_urlsafe(64))\" and set it in .env. "
            "For local development only, set DEBUG=true."
        )
    settings.SECRET_KEY = secrets.token_urlsafe(64)
    _log.warning("DEBUG mode: using a temporary SECRET_KEY. Sessions reset on restart.")

Path(settings.UPLOAD_DIR).mkdir(parents=True, exist_ok=True)
