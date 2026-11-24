from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from sqlalchemy import desc
from typing import List, Optional
from datetime import datetime

from app.core.database import get_db
from app.models.conversation import Conversation, ConversationMember
from app.models.message import Message, MessageReaction
from app.models.user import User
from app.schemas.message import (
    MessageResponse, MessageCreate, MessageUpdate, ReactionToggle, PinToggle
)
from app.services.auth_service import get_current_user
from app.services.chat_service import format_message, check_membership, create_message
from app.websocket.manager import manager

router = APIRouter(tags=["messages"])

@router.get("/api/conversations/{conversation_id}/messages", response_model=List[MessageResponse])
def get_messages(
    conversation_id: str,
    before_id: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=100),
    q: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    check_membership(conversation_id, current_user.id, db)

    query = db.query(Message).filter(Message.conversation_id == conversation_id)

    if q and q.strip():
        query = query.filter(Message.text.ilike(f"%{q.strip()}%"))

    if before_id:
        target_msg = db.query(Message).filter(Message.id == before_id).first()
        if target_msg:
            query = query.filter(Message.created_at < target_msg.created_at)

    messages = query.order_by(desc(Message.created_at)).limit(limit).all()
    # Return in chronological order
    messages.reverse()
    return [format_message(m, current_user.id, db) for m in messages]

@router.post("/api/conversations/{conversation_id}/messages", response_model=MessageResponse, status_code=status.HTTP_201_CREATED)
async def post_message(
    conversation_id: str,
    body: MessageCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    mem = check_membership(conversation_id, current_user.id, db)

    msg = create_message(
        conversation_id=conversation_id,
        sender_id=current_user.id,
        text=body.text,
        client_msg_id=body.client_msg_id,
        reply_to_id=body.reply_to_id,
        forwarded_from_id=body.forwarded_from_id,
        db=db
    )

    formatted = format_message(msg, current_user.id, db)

    # Broadcast via WebSocket to all members of the conversation
    conv = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    if conv:
        member_ids = {m.user_id for m in conv.members}
        await manager.broadcast_to_users(
            {
                "event": "new_message",
                "data": formatted.model_dump(mode="json")
            },
            member_ids
        )

    return formatted

@router.put("/api/messages/{message_id}", response_model=MessageResponse)
async def edit_message(
    message_id: str,
    body: MessageUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    msg = db.query(Message).filter(Message.id == message_id).first()
    if not msg:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found.")

    if msg.sender_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You can only edit your own messages.")

    msg.text = body.text
    msg.is_edited = True
    msg.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(msg)

    formatted = format_message(msg, current_user.id, db)

    # Broadcast edit
    conv = db.query(Conversation).filter(Conversation.id == msg.conversation_id).first()
    if conv:
        member_ids = {m.user_id for m in conv.members}
        await manager.broadcast_to_users(
            {
                "event": "message_edited",
                "data": formatted.model_dump(mode="json")
            },
            member_ids
        )

    return formatted

@router.delete("/api/messages/{message_id}")
async def delete_message(
    message_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    msg = db.query(Message).filter(Message.id == message_id).first()
    if not msg:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found.")

    mem = check_membership(msg.conversation_id, current_user.id, db)
    # Sender or group owner/admin can delete
    if msg.sender_id != current_user.id and mem.role not in ["owner", "admin"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied to delete this message.")

    conv_id = msg.conversation_id
    db.delete(msg)
    db.commit()

    # Broadcast deletion
    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if conv:
        member_ids = {m.user_id for m in conv.members}
        await manager.broadcast_to_users(
            {
                "event": "message_deleted",
                "data": {"message_id": message_id, "conversation_id": conv_id}
            },
            member_ids
        )

    return {"message": "Message deleted successfully."}

@router.post("/api/messages/{message_id}/reactions")
async def toggle_reaction(
    message_id: str,
    body: ReactionToggle,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    msg = db.query(Message).filter(Message.id == message_id).first()
    if not msg:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found.")

    check_membership(msg.conversation_id, current_user.id, db)

    existing = db.query(MessageReaction).filter(
        MessageReaction.message_id == message_id,
        MessageReaction.user_id == current_user.id,
        MessageReaction.emoji == body.emoji
    ).first()

    if existing:
        db.delete(existing)
    else:
        new_reaction = MessageReaction(
            message_id=message_id,
            user_id=current_user.id,
            emoji=body.emoji
        )
        db.add(new_reaction)

    db.commit()
    db.refresh(msg)

    formatted = format_message(msg, current_user.id, db)
    conv = db.query(Conversation).filter(Conversation.id == msg.conversation_id).first()
    if conv:
        member_ids = {m.user_id for m in conv.members}
        await manager.broadcast_to_users(
            {
                "event": "reaction_updated",
                "data": {
                    "message_id": message_id,
                    "conversation_id": msg.conversation_id,
                    "reactions": [r.model_dump(mode="json") for r in formatted.reactions]
                }
            },
            member_ids
        )

    return formatted

@router.post("/api/messages/{message_id}/pin")
async def toggle_pin(
    message_id: str,
    body: PinToggle,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    msg = db.query(Message).filter(Message.id == message_id).first()
    if not msg:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found.")

    mem = check_membership(msg.conversation_id, current_user.id, db)
    conv = db.query(Conversation).filter(Conversation.id == msg.conversation_id).first()

    msg.is_pinned = body.is_pinned
    if body.is_pinned:
        conv.pinned_message_id = msg.id
    else:
        if conv.pinned_message_id == msg.id:
            conv.pinned_message_id = None

    db.commit()
    db.refresh(msg)
    db.refresh(conv)

    formatted = format_message(msg, current_user.id, db)
    member_ids = {m.user_id for m in conv.members}
    await manager.broadcast_to_users(
        {
            "event": "message_pinned",
            "data": {
                "conversation_id": conv.id,
                "pinned_message_id": conv.pinned_message_id,
                "pinned_message": formatted.model_dump(mode="json") if body.is_pinned else None
            }
        },
        member_ids
    )

    return formatted

@router.post("/api/conversations/{conversation_id}/read")
async def mark_read(
    conversation_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Marks messages as read up to the newest one. The read pointer only moves forward."""
    mem = check_membership(conversation_id, current_user.id, db)

    latest_msg = db.query(Message).filter(
        Message.conversation_id == conversation_id
    ).order_by(desc(Message.created_at)).first()
    if not latest_msg:
        return {"conversation_id": conversation_id, "last_read_message_id": None}

    current = None
    if mem.last_read_message_id:
        current = db.query(Message).filter(Message.id == mem.last_read_message_id).first()
    if current is not None and current.created_at >= latest_msg.created_at:
        return {"conversation_id": conversation_id, "last_read_message_id": current.id}

    mem.last_read_message_id = latest_msg.id
    db.commit()

    conv = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    if conv:
        member_ids = {m.user_id for m in conv.members}
        await manager.broadcast_to_users(
            {
                "event": "message_read",
                "data": {
                    "conversation_id": conversation_id,
                    "user_id": current_user.id,
                    "last_read_message_id": latest_msg.id
                }
            },
            member_ids
        )

    return {"conversation_id": conversation_id, "last_read_message_id": latest_msg.id}

