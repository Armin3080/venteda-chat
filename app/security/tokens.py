"""JWT access tokens (PyJWT)."""
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

import jwt

from app.core.config import settings


def create_access_token(data: Dict[str, Any], expires_delta: Optional[timedelta] = None) -> str:
    now = datetime.now(timezone.utc)
    expires = now + (expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES))
    payload = {**data, "iat": now, "exp": expires}
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_access_token(token: str) -> Optional[Dict[str, Any]]:
    try:
        return jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except jwt.PyJWTError:
        return None
