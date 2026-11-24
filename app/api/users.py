import os
import secrets
import uuid
from fastapi import APIRouter, Depends, Query, HTTPException, status, UploadFile, File
from sqlalchemy.orm import Session
from sqlalchemy import or_
from typing import List

from app.core.database import get_db
from app.core.config import settings
from app.models.user import User
from app.schemas.user import UserResponse, UserSelfResponse, ConnectCodeVerifyRequest
from app.services.auth_service import get_current_user
from app.security.rate_limit import enforce_rate_limit

router = APIRouter(prefix="/api/users", tags=["users"])

@router.post("/me/avatar", response_model=UserSelfResponse)
async def upload_user_avatar(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Uploads and saves a user profile picture / avatar."""
    content_type = file.content_type or ""
    if not (content_type.startswith("image/") or file.filename.lower().endswith(('.png', '.jpg', '.jpeg', '.webp', '.gif'))):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid file type. Please upload a valid image file (PNG, JPG, WebP, GIF)."
        )

    # Read file contents and check size limit (5MB)
    contents = await file.read()
    if len(contents) > 5 * 1024 * 1024:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Avatar image size cannot exceed 5MB."
        )

    # Ensure uploads/avatars directory exists
    avatars_dir = os.path.join(settings.UPLOAD_DIR, "avatars")
    os.makedirs(avatars_dir, exist_ok=True)

    ext = os.path.splitext(file.filename)[1].lower() if file.filename else ".jpg"
    if not ext or len(ext) > 5:
        ext = ".jpg"
    filename = f"avatar_{uuid.uuid4().hex[:12]}{ext}"
    dest_path = os.path.join(avatars_dir, filename)

    with open(dest_path, "wb") as f:
        f.write(contents)

    avatar_url = f"/media/avatars/{filename}"
    user_db = db.query(User).filter(User.id == current_user.id).first()
    if user_db:
        user_db.avatar_url = avatar_url
        db.commit()
        db.refresh(user_db)
        return UserSelfResponse.from_orm(user_db)
    current_user.avatar_url = avatar_url
    db.commit()
    db.refresh(current_user)
    return UserSelfResponse.from_orm(current_user)

@router.delete("/me/avatar", response_model=UserSelfResponse)
def remove_user_avatar(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Removes the user's custom avatar and reverts to initials."""
    user_db = db.query(User).filter(User.id == current_user.id).first()
    if user_db:
        user_db.avatar_url = None
        db.commit()
        db.refresh(user_db)
        return UserSelfResponse.from_orm(user_db)
    current_user.avatar_url = None
    db.commit()
    db.refresh(current_user)
    return UserSelfResponse.from_orm(current_user)

@router.get("/search", response_model=List[UserResponse])
def search_users(
    q: str = Query(..., min_length=1, max_length=50),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    query = f"%{q.strip()}%"
    users = db.query(User).filter(
        User.id != current_user.id,
        or_(
            User.username.ilike(query),
            User.display_name.ilike(query)
        )
    ).limit(20).all()
    return [UserResponse.from_orm(u) for u in users]

@router.post("/verify-contact", response_model=UserResponse)
def verify_contact(
    payload: ConnectCodeVerifyRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Private contact discovery. Returns the user only when BOTH the username and
    the Connect PIN match. Other users' PINs are never sent to the client.
    """
    enforce_rate_limit(f"verify_{current_user.id}", max_requests=10, window_seconds=60)
    username = payload.username.strip().lstrip("@").lower()
    code = payload.connect_code.strip().upper()
    target = db.query(User).filter(User.username == username).first()
    if (
        target is None
        or target.id == current_user.id
        or not target.connect_code
        or not secrets.compare_digest(target.connect_code, code)
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No user matches that username and Connect PIN.",
        )
    return UserResponse.from_orm(target)

@router.get("/{user_id}", response_model=UserResponse)
def get_user_profile(
    user_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    return UserSelfResponse.from_orm(user)

