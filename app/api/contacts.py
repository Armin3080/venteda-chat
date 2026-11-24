"""Saved contacts, per-user settings, and user profiles."""
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.contact import UserContact
from app.models.conversation import Conversation, ConversationMember
from app.models.user import User
from app.schemas.contact import (
    ContactResponse,
    ContactUpdate,
    ProfileResponse,
    RelationshipResponse,
    SharedGroupResponse,
)
from app.schemas.user import UserResponse
from app.services.auth_service import get_current_user
from app.services.contact_service import shares_conversation
from app.services.story_service import active_query, media_exists, sees_author
from app.models.story import Story
from app.websocket.manager import manager

router = APIRouter(tags=["contacts"])


def _public_user(u: User) -> UserResponse:
    resp = UserResponse.from_orm(u)
    resp.is_online = manager.is_user_online(u.id)
    return resp


def _get_row(db: Session, owner_id: str, target_id: str):
    return db.query(UserContact).filter(
        UserContact.owner_id == owner_id,
        UserContact.target_id == target_id,
    ).first()


def _contact_response(row: UserContact, target: User) -> ContactResponse:
    return ContactResponse(
        user_id=target.id,
        username=target.username,
        display_name=target.display_name,
        nickname=row.nickname,
        is_saved=row.is_saved,
        notifications_muted=row.notifications_muted,
        is_blocked=row.is_blocked,
    )


def _shared_groups(db: Session, a: str, b: str) -> List[SharedGroupResponse]:
    a_ids = {r[0] for r in db.query(ConversationMember.conversation_id).filter(ConversationMember.user_id == a).all()}
    b_ids = {r[0] for r in db.query(ConversationMember.conversation_id).filter(ConversationMember.user_id == b).all()}
    common = a_ids & b_ids
    if not common:
        return []
    groups = db.query(Conversation).filter(Conversation.id.in_(common), Conversation.type == "group").all()
    return [SharedGroupResponse(id=g.id, title=g.title, member_count=len(g.members)) for g in groups]


@router.get("/api/contacts", response_model=List[ContactResponse])
def list_contacts(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.query(UserContact).filter(UserContact.owner_id == current_user.id).all()
    result = []
    for row in rows:
        target = db.query(User).filter(User.id == row.target_id).first()
        if target:
            result.append(_contact_response(row, target))
    return result


@router.get("/api/users/{user_id}/profile", response_model=ProfileResponse)
def get_profile(user_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    row = _get_row(db, current_user.id, target.id)
    # Profiles are visible only to people who share a conversation or saved the contact
    if row is None and not shares_conversation(db, current_user.id, target.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    relationship = RelationshipResponse(
        is_saved=bool(row and row.is_saved),
        nickname=row.nickname if row else None,
        notifications_muted=bool(row and row.notifications_muted),
        is_blocked=bool(row and row.is_blocked),
    )
    stories_count = 0
    if target.id != current_user.id and sees_author(db, current_user.id, target.id):
        stories_count = sum(1 for s in active_query(db).filter(Story.author_id == target.id).all()
                            if media_exists(s.media_url))
    return ProfileResponse(
        user=_public_user(target),
        relationship=relationship,
        shared_groups=_shared_groups(db, current_user.id, target.id),
        stories_count=stories_count,
    )


@router.put("/api/contacts/{user_id}", response_model=ContactResponse)
def update_contact(
    user_id: str,
    payload: ContactUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if user_id == current_user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot add yourself as a contact.")
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")

    row = _get_row(db, current_user.id, target.id)
    if row is None:
        if not shares_conversation(db, current_user.id, target.id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
        row = UserContact(owner_id=current_user.id, target_id=target.id)
        db.add(row)

    if payload.nickname is not None:
        row.nickname = payload.nickname.strip() or None
    if payload.is_saved is not None:
        row.is_saved = payload.is_saved
    if payload.notifications_muted is not None:
        row.notifications_muted = payload.notifications_muted
    if payload.is_blocked is not None:
        row.is_blocked = payload.is_blocked

    db.commit()
    db.refresh(row)
    return _contact_response(row, target)
