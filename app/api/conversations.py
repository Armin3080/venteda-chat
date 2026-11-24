import os
import uuid
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.orm import Session
from sqlalchemy import desc
from typing import List, Optional
from datetime import datetime

from app.core.config import settings
from app.core.database import get_db
from app.models.conversation import Conversation, ConversationMember
from app.models.message import Message
from app.models.user import User
from app.schemas.conversation import (
    ConversationResponse, ConversationCreate, ConversationMemberResponse,
    AddMembersRequest, MemberRoleUpdate
)
from app.schemas.user import UserResponse
from app.schemas.conversation import GroupUpdateRequest, MemberRoleUpdate
from app.services.auth_service import get_current_user
from app.websocket.manager import manager


def _live_user(u: User) -> UserResponse:
    """Member view with presence taken from live sockets, not the last saved flag."""
    resp = UserResponse.from_orm(u)
    resp.is_online = manager.is_user_online(u.id)
    return resp
from app.services.chat_service import format_message, check_membership

router = APIRouter(prefix="/api/conversations", tags=["conversations"])

def build_conversation_response(conv: Conversation, current_user_id: str, db: Session) -> ConversationResponse:
    # Find current user's membership
    current_mem = next((m for m in conv.members if m.user_id == current_user_id), None)
    is_muted = current_mem.is_muted if current_mem else False
    last_read_id = current_mem.last_read_message_id if current_mem else None

    # Calculate unread count
    unread_count = 0
    if last_read_id:
        read_msg = db.query(Message).filter(Message.id == last_read_id).first()
        if read_msg:
            unread_count = db.query(Message).filter(
                Message.conversation_id == conv.id,
                Message.created_at > read_msg.created_at,
                Message.sender_id != current_user_id
            ).count()
        else:
            unread_count = db.query(Message).filter(
                Message.conversation_id == conv.id,
                Message.sender_id != current_user_id
            ).count()
    else:
        unread_count = db.query(Message).filter(
            Message.conversation_id == conv.id,
            Message.sender_id != current_user_id
        ).count()

    # Get last message
    last_msg_obj = db.query(Message).filter(
        Message.conversation_id == conv.id
    ).order_by(desc(Message.created_at)).first()
    last_msg = format_message(last_msg_obj, current_user_id, db) if last_msg_obj else None

    # Get pinned message
    pinned_msg = None
    if conv.pinned_message_id:
        pinned_obj = db.query(Message).filter(Message.id == conv.pinned_message_id).first()
        if pinned_obj:
            pinned_msg = format_message(pinned_obj, current_user_id, db)

    members_resp = [
        ConversationMemberResponse(
            id=m.id,
            user_id=m.user_id,
            user=_live_user(m.user),
            role=m.role,
            is_muted=m.is_muted,
            last_read_message_id=m.last_read_message_id,
            joined_at=m.joined_at
        )
        for m in conv.members
    ]

    # For direct chat or saved messages, determine title and avatar
    display_title = conv.title
    display_avatar = conv.avatar_url
    if conv.type == "saved":
        display_title = "Saved Messages"
        display_avatar = None
    elif conv.type == "direct":
        other_mem = next((m for m in conv.members if m.user_id != current_user_id), None)
        if other_mem and other_mem.user:
            display_title = other_mem.user.display_name
            display_avatar = other_mem.user.avatar_url

    return ConversationResponse(
        id=conv.id,
        type=conv.type,
        title=display_title,
        description=conv.description,
        avatar_url=display_avatar,
        created_by_id=conv.created_by_id,
        pinned_message_id=conv.pinned_message_id,
        pinned_message=pinned_msg,
        last_message=last_msg,
        unread_count=unread_count,
        is_muted=is_muted,
        members=members_resp,
        created_at=conv.created_at,
        updated_at=conv.updated_at
    )

@router.get("/saved", response_model=ConversationResponse)
def get_or_create_saved_conversation(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    saved_conv = db.query(Conversation).filter(
        Conversation.type == "saved",
        Conversation.created_by_id == current_user.id
    ).first()
    if not saved_conv:
        saved_conv = Conversation(
            type="saved",
            title="Saved Messages",
            description="Your personal cloud storage for notes, files, and forwarded messages.",
            created_by_id=current_user.id,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow()
        )
        db.add(saved_conv)
        db.commit()
        db.refresh(saved_conv)
        mem = ConversationMember(conversation_id=saved_conv.id, user_id=current_user.id, role="owner")
        db.add(mem)
        db.commit()
        db.refresh(saved_conv)
    return build_conversation_response(saved_conv, current_user.id, db)

@router.get("", response_model=List[ConversationResponse])
def get_user_conversations(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    # Ensure Saved Messages conversation exists
    get_or_create_saved_conversation(current_user, db)

    # Fetch conversations where current user is a member
    memberships = db.query(ConversationMember).filter(
        ConversationMember.user_id == current_user.id
    ).all()
    conv_ids = [m.conversation_id for m in memberships]

    conversations = db.query(Conversation).filter(
        Conversation.id.in_(conv_ids)
    ).order_by(desc(Conversation.updated_at)).all()

    return [build_conversation_response(c, current_user.id, db) for c in conversations]

@router.post("", response_model=ConversationResponse, status_code=status.HTTP_201_CREATED)
def create_conversation(
    conv_in: ConversationCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if conv_in.type == "saved":
        return get_or_create_saved_conversation(current_user, db)

    if conv_in.type == "direct":
        if not conv_in.recipient_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Recipient ID is required for direct chat.")
        if conv_in.recipient_id == current_user.id:
            return get_or_create_saved_conversation(current_user, db)

        recipient = db.query(User).filter(User.id == conv_in.recipient_id).first()
        if not recipient:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recipient user not found.")

        # Check if direct conversation already exists between these two users
        existing_direct = db.query(Conversation).filter(
            Conversation.type == "direct"
        ).all()
        for c in existing_direct:
            member_ids = {m.user_id for m in c.members}
            if member_ids == {current_user.id, conv_in.recipient_id}:
                return build_conversation_response(c, current_user.id, db)

        # Create new direct conversation
        conv = Conversation(
            type="direct",
            created_by_id=current_user.id,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow()
        )
        db.add(conv)
        db.commit()
        db.refresh(conv)

        mem1 = ConversationMember(conversation_id=conv.id, user_id=current_user.id, role="member")
        mem2 = ConversationMember(conversation_id=conv.id, user_id=conv_in.recipient_id, role="member")
        db.add_all([mem1, mem2])
        db.commit()
        db.refresh(conv)

        return build_conversation_response(conv, current_user.id, db)

    elif conv_in.type == "group":
        if not conv_in.title or not conv_in.title.strip():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Group title is required.")

        conv = Conversation(
            type="group",
            title=conv_in.title.strip(),
            description=conv_in.description.strip() if conv_in.description else None,
            created_by_id=current_user.id,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow()
        )
        db.add(conv)
        db.commit()
        db.refresh(conv)

        # Creator is owner
        owner_mem = ConversationMember(conversation_id=conv.id, user_id=current_user.id, role="owner")
        db.add(owner_mem)

        # Add initial members
        if conv_in.member_ids:
            for uid in set(conv_in.member_ids):
                if uid != current_user.id:
                    u = db.query(User).filter(User.id == uid).first()
                    if u:
                        db.add(ConversationMember(conversation_id=conv.id, user_id=uid, role="member"))

        db.commit()
        db.refresh(conv)
        return build_conversation_response(conv, current_user.id, db)

    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid conversation type.")

@router.get("/{conversation_id}", response_model=ConversationResponse)
def get_conversation(
    conversation_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    check_membership(conversation_id, current_user.id, db)
    conv = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    if not conv:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found.")
    return build_conversation_response(conv, current_user.id, db)

@router.post("/{conversation_id}/mute")
def toggle_mute(
    conversation_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    mem = check_membership(conversation_id, current_user.id, db)
    mem.is_muted = not mem.is_muted
    db.commit()
    return {"conversation_id": conversation_id, "is_muted": mem.is_muted}

@router.post("/{conversation_id}/members", response_model=ConversationResponse)
def add_members_to_group(
    conversation_id: str,
    body: AddMembersRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    mem = check_membership(conversation_id, current_user.id, db)
    conv = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    if conv.type != "group":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Can only add members to group conversations.")
    
    # Must be owner or admin
    if mem.role not in ["owner", "admin"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only group admins or owners can add members.")

    existing_members = {m.user_id for m in conv.members}
    for uid in body.user_ids:
        if uid not in existing_members:
            user = db.query(User).filter(User.id == uid).first()
            if user:
                db.add(ConversationMember(conversation_id=conv.id, user_id=uid, role="member"))

    db.commit()
    db.refresh(conv)
    return build_conversation_response(conv, current_user.id, db)

@router.delete("/{conversation_id}/leave")
async def leave_conversation(
    conversation_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    mem = check_membership(conversation_id, current_user.id, db)
    if mem.role == "owner":
        successor = db.query(ConversationMember).filter(
            ConversationMember.conversation_id == conversation_id,
            ConversationMember.user_id != current_user.id,
        ).order_by(ConversationMember.role.asc(), ConversationMember.joined_at).first()
        if successor:
            successor.role = "owner"
    db.delete(mem)
    db.commit()
    await _notify_conversation(conversation_id, db)
    return {"message": "Left conversation successfully."}


# ---------------------------------------------------------------------------
# Group management (Telegram-style): info, photo, members, roles
# ---------------------------------------------------------------------------
GROUP_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}


async def _notify_conversation(conversation_id: str, db: Session) -> None:
    """Tell every member to refresh this conversation."""
    member_ids = {m.user_id for m in db.query(ConversationMember).filter(
        ConversationMember.conversation_id == conversation_id).all()}
    await manager.broadcast_to_users(
        {"event": "conversation_updated", "data": {"conversation_id": conversation_id}},
        member_ids,
    )


def _group_manager(conversation_id: str, user_id: str, db: Session):
    """Returns (conversation, my_membership) for owners and admins of a group."""
    mem = check_membership(conversation_id, user_id, db)
    conv = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    if not conv or conv.type != "group":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This is not a group.")
    if mem.role not in ("owner", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only group owners and admins can do this.")
    return conv, mem


@router.patch("/{conversation_id}", response_model=ConversationResponse)
async def update_group_info(
    conversation_id: str,
    body: GroupUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    conv, _ = _group_manager(conversation_id, current_user.id, db)
    if body.title is not None:
        conv.title = body.title.strip()
    if body.description is not None:
        conv.description = body.description.strip() or None
    conv.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(conv)
    await _notify_conversation(conversation_id, db)
    return build_conversation_response(conv, current_user.id, db)


@router.post("/{conversation_id}/avatar", response_model=ConversationResponse)
async def upload_group_avatar(
    conversation_id: str,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    conv, _ = _group_manager(conversation_id, current_user.id, db)
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in GROUP_IMAGE_EXTENSIONS or not (file.content_type or "image/").startswith("image/"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Please upload a PNG, JPG, WebP or GIF image.")
    data = await file.read()
    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Group photo cannot exceed 5MB.")
    folder = os.path.join(settings.UPLOAD_DIR, "groups")
    os.makedirs(folder, exist_ok=True)
    name = f"group_{uuid.uuid4().hex[:12]}{ext}"
    with open(os.path.join(folder, name), "wb") as out:
        out.write(data)
    conv.avatar_url = f"/media/groups/{name}"
    db.commit()
    db.refresh(conv)
    await _notify_conversation(conversation_id, db)
    return build_conversation_response(conv, current_user.id, db)


@router.delete("/{conversation_id}/members/{user_id}", response_model=ConversationResponse)
async def remove_group_member(
    conversation_id: str,
    user_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    conv, me = _group_manager(conversation_id, current_user.id, db)
    target = db.query(ConversationMember).filter(
        ConversationMember.conversation_id == conversation_id,
        ConversationMember.user_id == user_id,
    ).first()
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This user is not in the group.")
    if target.role == "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="The owner cannot be removed.")
    if me.role == "admin" and target.role != "member":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admins can only remove regular members.")
    db.delete(target)
    db.commit()
    db.refresh(conv)
    await _notify_conversation(conversation_id, db)
    return build_conversation_response(conv, current_user.id, db)


@router.put("/{conversation_id}/members/{user_id}/role", response_model=ConversationResponse)
async def set_group_member_role(
    conversation_id: str,
    user_id: str,
    body: MemberRoleUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    conv, me = _group_manager(conversation_id, current_user.id, db)
    if me.role != "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the owner can change roles.")
    target = db.query(ConversationMember).filter(
        ConversationMember.conversation_id == conversation_id,
        ConversationMember.user_id == user_id,
    ).first()
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This user is not in the group.")
    if target.role == "owner":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="The owner's role cannot be changed.")
    target.role = body.role
    db.commit()
    db.refresh(conv)
    await _notify_conversation(conversation_id, db)
    return build_conversation_response(conv, current_user.id, db)

