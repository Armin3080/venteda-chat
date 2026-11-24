"""Extended administration: account editing, activation, notes, risk score, sessions,
advanced search, story moderation and avatar removal.

Every write requires a reason and is recorded in the audit log.
Staff notes and risk scores are never returned to the user they describe.
"""
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.api.admin import create_audit_entry
from app.core.database import get_db
from app.models.admin import AuditLog, ModerationReport
from app.models.admin_note import AdminNote
from app.models.story import Story
from app.models.user import User, UserSession
from app.services.auth_service import require_moderator_or_higher, require_staff
from app.services.story_service import remove_story_media
from app.websocket.manager import manager

router = APIRouter(prefix="/api/admin", tags=["admin-extended"])


class ReasonRequest(BaseModel):
    reason: str = Field(..., min_length=5, max_length=500)


class AccountEdit(BaseModel):
    reason: str = Field(..., min_length=5, max_length=500)
    display_name: Optional[str] = Field(None, min_length=1, max_length=100)
    username: Optional[str] = Field(None, min_length=3, max_length=32, pattern=r"^[A-Za-z0-9_]+$")
    email: Optional[EmailStr] = None
    bio: Optional[str] = Field(None, max_length=255)


class ActivationRequest(BaseModel):
    active: bool
    reason: str = Field(..., min_length=5, max_length=500)


class NoteRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)


def _target(db: Session, user_id: str) -> User:
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    return target


def _guard_staff_target(actor: User, target: User) -> None:
    """Only the owner may change owners or other staff accounts."""
    if target.role == "owner" and actor.role != "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the owner can change the owner account.")
    if target.role in ("moderator", "support") and actor.role != "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the owner can change staff accounts.")


def _risk(db: Session, target: User) -> dict:
    """Simple, explainable score from warnings, open reports and ban state. 0 = clean, 100 = high risk."""
    open_reports = db.query(ModerationReport).filter(
        ModerationReport.reported_user_id == target.id,
        ModerationReport.status.in_(["pending", "under_review"]),
    ).count()
    warnings = target.warning_count or 0
    points = {
        "warnings": min(warnings * 15, 45),
        "open_reports": min(open_reports * 10, 40),
        "banned": 40 if target.is_banned else 0,
    }
    score = min(sum(points.values()), 100)
    level = "high" if score >= 60 else "medium" if score >= 25 else "low"
    return {"score": score, "level": level, "breakdown": points}


# ---------------------------------------------------------------- users
@router.get("/users/search")
def search_users(
    q: str = Query("", max_length=100),
    role: Optional[str] = Query(None, pattern="^(owner|moderator|support|user)$"),
    status_filter: Optional[str] = Query(None, alias="status", pattern="^(active|inactive|banned)$"),
    min_risk: int = Query(0, ge=0, le=100),
    limit: int = Query(50, ge=1, le=200),
    current_user: User = Depends(require_staff),
    db: Session = Depends(get_db),
):
    query = db.query(User)
    if q.strip():
        term = f"%{q.strip().lower()}%"
        query = query.filter(or_(User.username.ilike(term), User.display_name.ilike(term), User.email.ilike(term)))
    if role:
        query = query.filter(User.role == role)
    if status_filter == "active":
        query = query.filter(User.is_active.is_(True), User.is_banned.is_(False))
    elif status_filter == "inactive":
        query = query.filter(User.is_active.is_(False))
    elif status_filter == "banned":
        query = query.filter(User.is_banned.is_(True))
    results = []
    for user in query.order_by(User.created_at.desc()).limit(limit * 3).all():
        risk = _risk(db, user)
        if risk["score"] < min_risk:
            continue
        results.append({
            "id": user.id, "username": user.username, "display_name": user.display_name,
            "role": user.role, "is_active": bool(user.is_active), "is_banned": bool(user.is_banned),
            "is_online": bool(user.is_online), "last_seen": user.last_seen, "risk": risk,
        })
        if len(results) >= limit:
            break
    return results


@router.patch("/users/{user_id}")
def edit_account(
    user_id: str, body: AccountEdit, request: Request,
    current_user: User = Depends(require_moderator_or_higher), db: Session = Depends(get_db),
):
    target = _target(db, user_id)
    _guard_staff_target(current_user, target)
    changes = {}
    if body.display_name is not None:
        changes["display_name"] = body.display_name.strip()
    if body.username is not None:
        new_name = body.username.strip().lower()
        if new_name != target.username:
            if db.query(User).filter(User.username == new_name, User.id != target.id).first():
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This username is already taken.")
            changes["username"] = new_name
    if body.email is not None:
        new_email = str(body.email).lower()
        if new_email != (target.email or "") and db.query(User).filter(User.email == new_email, User.id != target.id).first():
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This email is already in use.")
        changes["email"] = new_email
    if body.bio is not None:
        changes["bio"] = body.bio.strip() or None
    if not changes:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Nothing to change.")
    for key, value in changes.items():
        setattr(target, key, value)
    create_audit_entry(db=db, actor=current_user, action="USER_EDIT", target_type="user", target_id=target.id,
                       reason=body.reason, metadata={"fields": sorted(changes.keys())},
                       ip_address=request.client.host if request.client else "unknown")
    db.commit()
    return {"ok": True, "changed": sorted(changes.keys())}


@router.post("/users/{user_id}/activation")
async def set_activation(
    user_id: str, body: ActivationRequest, request: Request,
    current_user: User = Depends(require_moderator_or_higher), db: Session = Depends(get_db),
):
    target = _target(db, user_id)
    _guard_staff_target(current_user, target)
    if target.id == current_user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot deactivate your own account.")
    target.is_active = body.active
    if not body.active:
        db.query(UserSession).filter(UserSession.user_id == target.id).update({"is_revoked": True})
    create_audit_entry(db=db, actor=current_user, action="USER_ACTIVATION" if body.active else "USER_DEACTIVATE",
                       target_type="user", target_id=target.id, reason=body.reason, metadata=None,
                       ip_address=request.client.host if request.client else "unknown")
    db.commit()
    if not body.active:
        await manager.disconnect_user(target.id)
    return {"ok": True, "is_active": bool(target.is_active)}


@router.get("/users/{user_id}/sessions")
def list_sessions(user_id: str, current_user: User = Depends(require_staff), db: Session = Depends(get_db)):
    _target(db, user_id)
    rows = db.query(UserSession).filter(UserSession.user_id == user_id).order_by(UserSession.last_active_at.desc()).limit(100).all()
    return [{
        "id": s.id, "device_name": s.device_name, "browser": s.browser, "ip_address": s.ip_address,
        "created_at": s.created_at, "last_active_at": s.last_active_at, "is_revoked": bool(s.is_revoked),
    } for s in rows]


@router.get("/users/{user_id}/risk")
def user_risk(user_id: str, current_user: User = Depends(require_staff), db: Session = Depends(get_db)):
    return _risk(db, _target(db, user_id))


@router.get("/users/{user_id}/violations")
def user_violations(user_id: str, current_user: User = Depends(require_staff), db: Session = Depends(get_db)):
    """Warnings, bans and reports against the user, from the audit log and the report table."""
    _target(db, user_id)
    actions = db.query(AuditLog).filter(
        AuditLog.target_id == user_id,
        AuditLog.action.in_(["USER_WARN", "USER_BAN", "USER_UNBAN", "USER_EDIT", "USER_ACTIVATION", "USER_DEACTIVATE", "AVATAR_REMOVE"]),
    ).order_by(AuditLog.created_at.desc()).limit(100).all()
    reports = db.query(ModerationReport).filter(ModerationReport.reported_user_id == user_id).order_by(
        ModerationReport.created_at.desc()).limit(100).all()
    return {
        "actions": [{"action": a.action, "actor": a.actor_username, "reason": a.reason, "created_at": a.created_at} for a in actions],
        "reports": [{"id": r.id, "category": r.reason_category, "status": r.status, "created_at": r.created_at} for r in reports],
    }


# ---------------------------------------------------------------- private notes
@router.get("/users/{user_id}/notes")
def list_notes(user_id: str, current_user: User = Depends(require_staff), db: Session = Depends(get_db)):
    _target(db, user_id)
    rows = db.query(AdminNote).filter(AdminNote.user_id == user_id).order_by(AdminNote.created_at.desc()).all()
    return [{"id": n.id, "author": n.author_username, "text": n.text, "created_at": n.created_at} for n in rows]


@router.post("/users/{user_id}/notes", status_code=status.HTTP_201_CREATED)
def add_note(user_id: str, body: NoteRequest, current_user: User = Depends(require_staff), db: Session = Depends(get_db)):
    _target(db, user_id)
    note = AdminNote(user_id=user_id, author_id=current_user.id, author_username=current_user.username,
                     text=body.text.strip(), created_at=datetime.utcnow())
    db.add(note)
    db.commit()
    return {"ok": True, "id": note.id}


# ---------------------------------------------------------------- content
@router.get("/stories")
def list_stories(limit: int = Query(100, ge=1, le=300), current_user: User = Depends(require_staff), db: Session = Depends(get_db)):
    rows = db.query(Story).filter(Story.expires_at > datetime.utcnow()).order_by(Story.created_at.desc()).limit(limit).all()
    authors = {u.id: u for u in db.query(User).filter(User.id.in_([s.author_id for s in rows])).all()} if rows else {}
    return [{
        "id": s.id, "author": authors[s.author_id].username if s.author_id in authors else None,
        "media_type": s.media_type, "media_url": s.media_url, "caption": s.caption,
        "created_at": s.created_at, "expires_at": s.expires_at, "is_platform": bool(s.is_platform),
    } for s in rows]


@router.delete("/stories/{story_id}")
def remove_story(story_id: str, body: ReasonRequest, request: Request,
                 current_user: User = Depends(require_moderator_or_higher), db: Session = Depends(get_db)):
    story = db.query(Story).filter(Story.id == story_id).first()
    if not story:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Story not found.")
    from app.services.story_service import delete_story
    create_audit_entry(db=db, actor=current_user, action="STORY_REMOVE", target_type="story", target_id=story.id,
                       reason=body.reason, metadata={"author_id": story.author_id},
                       ip_address=request.client.host if request.client else "unknown")
    delete_story(db, story)
    return {"ok": True}


@router.delete("/users/{user_id}/avatar")
def remove_avatar(user_id: str, body: ReasonRequest, request: Request,
                  current_user: User = Depends(require_moderator_or_higher), db: Session = Depends(get_db)):
    target = _target(db, user_id)
    _guard_staff_target(current_user, target)
    old = target.avatar_url
    target.avatar_url = None
    create_audit_entry(db=db, actor=current_user, action="AVATAR_REMOVE", target_type="user", target_id=target.id,
                       reason=body.reason, metadata={"previous": old},
                       ip_address=request.client.host if request.client else "unknown")
    db.commit()
    return {"ok": True}
