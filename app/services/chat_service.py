from typing import List, Optional, Dict
from datetime import datetime
from sqlalchemy.orm import Session
from sqlalchemy import desc, func
from fastapi import HTTPException, status

from app.models.conversation import Conversation, ConversationMember
from app.models.message import Message, MessageReaction
from app.models.attachment import Attachment
from app.models.user import User
from app.schemas.message import MessageResponse, ReactionSummary, MessageReplyPreview
from app.schemas.attachment import AttachmentResponse
from app.schemas.user import UserResponse
from app.services.contact_service import is_blocked_between

def format_message(message: Message, current_user_id: Optional[str] = None, db: Optional[Session] = None) -> MessageResponse:
    # Build reaction summaries
    reaction_map: Dict[str, List[str]] = {}
    for r in message.reactions:
        if r.emoji not in reaction_map:
            reaction_map[r.emoji] = []
        reaction_map[r.emoji].append(r.user_id)
    
    reactions = [
        ReactionSummary(emoji=emoji, count=len(uids), user_ids=uids)
        for emoji, uids in reaction_map.items()
    ]

    # Build reply preview if available
    reply_preview = None
    if message.reply_to_id and db:
        rep_msg = db.query(Message).filter(Message.id == message.reply_to_id).first()
        if rep_msg:
            sender_name = rep_msg.sender.display_name if rep_msg.sender else "Unknown"
            reply_preview = MessageReplyPreview(
                id=rep_msg.id,
                text=rep_msg.text[:80],
                sender_name=sender_name
            )

    attachments = [
        AttachmentResponse(
            id=att.id,
            message_id=att.message_id,
            file_name=att.file_name,
            original_name=att.original_name,
            mime_type=att.mime_type,
            file_size=att.file_size,
            duration_seconds=getattr(att, 'duration_seconds', 0) or 0,
            created_at=att.created_at
        )
        for att in message.attachments
    ]

    sender_resp = None
    if message.sender:
        sender_resp = UserResponse.from_orm(message.sender)

    # Calculate read status (if any other member has last_read_message_id >= this message or joined)
    is_read = False
    if db:
        other_members = db.query(ConversationMember).filter(
            ConversationMember.conversation_id == message.conversation_id,
            ConversationMember.user_id != message.sender_id
        ).all()
        # For simplicity, if any other member has this message or later as last_read
        for m in other_members:
            if m.last_read_message_id:
                read_at = db.query(Message.created_at).filter(Message.id == m.last_read_message_id).scalar()
                if read_at is not None and read_at >= message.created_at:
                    is_read = True
                    break

    return MessageResponse(
        id=message.id,
        client_msg_id=message.client_msg_id,
        conversation_id=message.conversation_id,
        sender_id=message.sender_id,
        sender=sender_resp,
        text=message.text,
        reply_to_id=message.reply_to_id,
        reply_preview=reply_preview,
        forwarded_from_id=message.forwarded_from_id,
        forwarded_from_title=message.forwarded_from_title,
        is_edited=message.is_edited,
        is_pinned=message.is_pinned,
        created_at=message.created_at,
        updated_at=message.updated_at,
        attachments=attachments,
        reactions=reactions,
        is_read_by_recipient=is_read
    )

def check_membership(conversation_id: str, user_id: str, db: Session) -> ConversationMember:
    member = db.query(ConversationMember).filter(
        ConversationMember.conversation_id == conversation_id,
        ConversationMember.user_id == user_id
    ).first()
    if not member:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not a member of this conversation."
        )
    return member

def create_message(
    conversation_id: str,
    sender_id: str,
    text: str,
    client_msg_id: Optional[str] = None,
    reply_to_id: Optional[str] = None,
    forwarded_from_id: Optional[str] = None,
    forwarded_from_title: Optional[str] = None,
    db: Session = None
) -> Message:
    # Deduplication check
    if client_msg_id:
        existing = db.query(Message).filter(Message.client_msg_id == client_msg_id).first()
        if existing:
            return existing

    # Verify membership
    check_membership(conversation_id, sender_id, db)

    # Blocked users cannot message each other in direct chats
    conv_for_block = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    if conv_for_block and conv_for_block.type == "direct":
        other = db.query(ConversationMember.user_id).filter(
            ConversationMember.conversation_id == conversation_id,
            ConversationMember.user_id != sender_id,
        ).first()
        if other and is_blocked_between(db, sender_id, other[0]):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You cannot send messages to this user.")

    # Validate reply
    if reply_to_id:
        reply_msg = db.query(Message).filter(
            Message.id == reply_to_id,
            Message.conversation_id == conversation_id
        ).first()
        if not reply_msg:
            reply_to_id = None

    msg = Message(
        conversation_id=conversation_id,
        sender_id=sender_id,
        text=text,
        client_msg_id=client_msg_id,
        reply_to_id=reply_to_id,
        forwarded_from_id=forwarded_from_id,
        forwarded_from_title=forwarded_from_title,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow()
    )
    db.add(msg)

    # Update conversation updated_at
    conv = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    if conv:
        conv.updated_at = datetime.utcnow()

    # Automatically set sender's last_read_message_id
    member = db.query(ConversationMember).filter(
        ConversationMember.conversation_id == conversation_id,
        ConversationMember.user_id == sender_id
    ).first()
    if member:
        member.last_read_message_id = msg.id

    db.commit()
    db.refresh(msg)
    return msg
