from fastapi import Depends, HTTPException, Request, Response, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
from typing import Optional, List
from datetime import datetime, timedelta
from app.core.database import get_db
from app.models.user import User, UserSession
from app.security.tokens import create_access_token, decode_access_token

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)

def get_current_user(token: Optional[str] = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication credentials were not provided.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    payload = decode_access_token(token)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired authentication token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user_id = payload.get("sub")
    jti = payload.get("jti")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User associated with token no longer exists.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if user.is_active is False:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account is deactivated. Contact an administrator.",
        )

    # Check if user is banned
    if user.is_banned:
        # Check if temporary ban has expired
        if user.ban_expires_at and user.ban_expires_at < datetime.utcnow():
            user.is_banned = False
            user.ban_reason = None
            user.ban_expires_at = None
            db.commit()
        else:
            ban_detail = f"Your account has been suspended. Reason: {user.ban_reason or 'Terms of service violation.'}"
            if user.ban_expires_at:
                ban_detail += f" Expiration: {user.ban_expires_at.isoformat()}"
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=ban_detail
            )

    # Tokens carrying a JTI must map to a persisted, non-revoked session.
    if jti:
        session_rec = db.query(UserSession).filter(
            UserSession.token_jti == jti, UserSession.user_id == user.id
        ).first()
        if not session_rec or session_rec.is_revoked:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="This session has been terminated or is no longer valid.",
            )
        now = datetime.utcnow()
        if not session_rec.last_active_at or session_rec.last_active_at < now - timedelta(minutes=5):
            session_rec.last_active_at = now
            db.commit()

    return user

def require_role(allowed_roles: List[str]):
    def role_checker(current_user: User = Depends(get_current_user)) -> User:
        if current_user.role not in allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Access denied. Required role: {', '.join(allowed_roles)}. Your role: {current_user.role}."
            )
        return current_user
    return role_checker

require_owner = require_role(["owner"])
require_moderator_or_higher = require_role(["owner", "moderator"])
require_staff = require_role(["owner", "moderator", "support"])


def create_user_session(db: Session, user: User, request: Request) -> str:
    """Issue a JWT and persist its session so device revocation is enforceable."""
    import uuid

    user_agent = request.headers.get("user-agent", "Unknown browser")[:100]
    ua = user_agent.lower()
    if "edg/" in ua:
        browser = "Microsoft Edge"
    elif "firefox/" in ua:
        browser = "Mozilla Firefox"
    elif "chrome/" in ua and "chromium" not in ua:
        browser = "Google Chrome"
    elif "safari/" in ua and "chrome/" not in ua:
        browser = "Safari"
    else:
        browser = user_agent[:100] or "Unknown browser"

    if any(marker in ua for marker in ("iphone", "android", "mobile")):
        device_name = "Mobile device"
    elif "ipad" in ua or "tablet" in ua:
        device_name = "Tablet"
    else:
        device_name = "Desktop / Laptop"

    jti = uuid.uuid4().hex
    token = create_access_token({"sub": user.id, "username": user.username, "jti": jti})
    now = datetime.utcnow()
    db.add(UserSession(
        user_id=user.id,
        token_jti=jti,
        device_name=device_name,
        browser=browser,
        ip_address=request.client.host if request.client else "unknown",
        is_revoked=False,
        created_at=now,
        last_active_at=now,
    ))
    db.commit()
    return token

def get_user_from_token(token: str, db: Session) -> Optional[User]:
    payload = decode_access_token(token)
    if not payload:
        return None
    user_id = payload.get("sub")
    if not user_id:
        return None
    user = db.query(User).filter(User.id == user_id).first()
    if not user or user.is_banned:
        return None
    return user


# ---------------------------------------------------------------------------
# Session cookie for browser-loaded media (<img>, <audio>, <video> cannot send
# an Authorization header). The cookie is HttpOnly, so scripts cannot read it.
# ---------------------------------------------------------------------------
SESSION_COOKIE = "venteda_session"


def set_session_cookie(response: Response, token: str) -> None:
    from app.core.config import settings
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        max_age=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        httponly=True,
        secure=settings.COOKIE_SECURE,
        samesite="lax",
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(key=SESSION_COOKIE, path="/")


def user_from_cookie(request: Request, db) -> Optional[User]:
    """Same checks as get_current_user (ban, revocation, expiry), but reads the session cookie."""
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    try:
        return get_current_user(token=token, db=db)
    except HTTPException:
        return None

