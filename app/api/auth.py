from fastapi import APIRouter, Depends, HTTPException, status, Request
from sqlalchemy.orm import Session
from datetime import datetime

from app.core.database import get_db
from app.models.user import User, UserSettings, UserSession
from app.schemas.user import (
    UserCreate, UserLogin, UserSelfResponse, AuthResponse,
    UserSettingsResponse, UserSettingsUpdate, UserUpdate
)
from app.security.passwords import verify_password, get_password_hash
from app.security.tokens import decode_access_token
from fastapi import Response
from app.services.auth_service import (
    set_session_cookie, clear_session_cookie, create_user_session, SESSION_COOKIE,
)
from app.security.rate_limit import enforce_rate_limit
from app.security.connect_code import unique_connect_code
from app.services.auth_service import get_current_user

router = APIRouter(prefix="/api/auth", tags=["auth"])

@router.post("/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
def register(user_in: UserCreate, request: Request, response: Response, db: Session = Depends(get_db)):
    # Rate limit registration attempts
    client_ip = request.client.host if request.client else "unknown"
    enforce_rate_limit(f"reg_{client_ip}", max_requests=10, window_seconds=60)

    # Check username
    existing_user = db.query(User).filter(User.username == user_in.username.strip().lower()).first()
    if existing_user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username is already taken."
        )

    # Check email if provided
    if user_in.email:
        existing_email = db.query(User).filter(User.email == user_in.email.strip().lower()).first()
        if existing_email:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Email is already registered."
            )

    new_user = User(
        username=user_in.username.strip().lower(),
        display_name=user_in.display_name.strip(),
        email=user_in.email.strip().lower() if user_in.email else None,
        bio=user_in.bio.strip() if user_in.bio else "Hey there! I am using Venteda Chat.",
        password_hash=get_password_hash(user_in.password),
        connect_code=unique_connect_code(db),
        is_online=True,
        last_seen=datetime.utcnow()
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    # Create default settings
    user_settings = UserSettings(user_id=new_user.id)
    db.add(user_settings)
    db.commit()

    token = create_user_session(db, new_user, request)
    set_session_cookie(response, token)
    return AuthResponse(
        access_token=token,
        token_type="bearer",
        user=UserSelfResponse.from_orm(new_user)
    )

@router.post("/login", response_model=AuthResponse)
def login(login_data: UserLogin, request: Request, response: Response, db: Session = Depends(get_db)):
    client_ip = request.client.host if request.client else "unknown"
    enforce_rate_limit(f"login_{client_ip}", max_requests=20, window_seconds=60)

    user = db.query(User).filter(User.username == login_data.username.strip().lower()).first()
    if not user or not verify_password(login_data.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password."
        )
    if user.is_active is False:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This account is deactivated.")
    if user.is_banned:
        if user.ban_expires_at and user.ban_expires_at < datetime.utcnow():
            user.is_banned = False
            user.ban_reason = None
            user.ban_expires_at = None
        else:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This account is suspended.")

    user.is_online = True
    user.last_seen = datetime.utcnow()
    db.commit()

    token = create_user_session(db, user, request)
    set_session_cookie(response, token)
    return AuthResponse(
        access_token=token,
        token_type="bearer",
        user=UserSelfResponse.from_orm(user)
    )

@router.get("/me", response_model=UserSelfResponse)
def get_me(current_user: User = Depends(get_current_user)):
    return UserSelfResponse.from_orm(current_user)

@router.put("/me", response_model=UserSelfResponse)
def update_me(user_update: UserUpdate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if user_update.display_name is not None:
        current_user.display_name = user_update.display_name.strip()
    if user_update.bio is not None:
        current_user.bio = user_update.bio.strip()
    if user_update.avatar_url is not None:
        current_user.avatar_url = user_update.avatar_url
    if user_update.email is not None:
        current_user.email = user_update.email.strip().lower()
    if user_update.username is not None:
        new_username = user_update.username.strip().lower()
        if new_username != current_user.username:
            taken = db.query(User).filter(User.username == new_username, User.id != current_user.id).first()
            if taken:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This username is already taken.")
            current_user.username = new_username

    db.commit()
    db.refresh(current_user)
    return UserSelfResponse.from_orm(current_user)

@router.get("/settings", response_model=UserSettingsResponse)
def get_settings(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    settings_obj = db.query(UserSettings).filter(UserSettings.user_id == current_user.id).first()
    if not settings_obj:
        settings_obj = UserSettings(user_id=current_user.id)
        db.add(settings_obj)
        db.commit()
        db.refresh(settings_obj)
    return UserSettingsResponse.from_orm(settings_obj)

@router.put("/settings", response_model=UserSettingsResponse)
def update_settings(update_data: UserSettingsUpdate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    settings_obj = db.query(UserSettings).filter(UserSettings.user_id == current_user.id).first()
    if not settings_obj:
        settings_obj = UserSettings(user_id=current_user.id)
        db.add(settings_obj)

    if update_data.theme is not None:
        settings_obj.theme = update_data.theme
    if update_data.language is not None:
        settings_obj.language = update_data.language
    if update_data.notifications_enabled is not None:
        settings_obj.notifications_enabled = update_data.notifications_enabled
    if update_data.sound_enabled is not None:
        settings_obj.sound_enabled = update_data.sound_enabled
    if update_data.enter_is_send is not None:
        settings_obj.enter_is_send = update_data.enter_is_send

    db.commit()
    db.refresh(settings_obj)
    return UserSettingsResponse.from_orm(settings_obj)

@router.post("/logout")
def logout(
    request: Request,
    response: Response,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    authorization = request.headers.get("authorization", "")
    token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else None
    if not token:
        token = request.cookies.get(SESSION_COOKIE)
    payload = decode_access_token(token) if token else None
    jti = payload.get("jti") if payload else None
    if jti:
        session_rec = db.query(UserSession).filter(
            UserSession.token_jti == jti, UserSession.user_id == current_user.id
        ).first()
        if session_rec:
            session_rec.is_revoked = True
            db.flush()  # SessionLocal disables autoflush; count after persisting this revocation.

    remaining_sessions = db.query(UserSession).filter(
        UserSession.user_id == current_user.id, UserSession.is_revoked.is_(False)
    ).count()
    if remaining_sessions == 0:
        current_user.is_online = False
        current_user.last_seen = datetime.utcnow()
    db.commit()
    clear_session_cookie(response)
    return {"message": "Logged out successfully."}


@router.post("/connect-code/regenerate", response_model=UserSelfResponse)
def regenerate_connect_code(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    enforce_rate_limit(f"pin_{current_user.id}", max_requests=5, window_seconds=3600)
    user_db = db.query(User).filter(User.id == current_user.id).first() or current_user
    user_db.connect_code = unique_connect_code(db)
    db.commit()
    db.refresh(user_db)
    return UserSelfResponse.from_orm(user_db)
