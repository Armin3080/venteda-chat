import os
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Form
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from datetime import datetime

from app.core.database import get_db
from app.core.config import settings
from app.models.attachment import Attachment
from app.models.message import Message
from app.models.conversation import Conversation
from app.models.user import User
from app.schemas.attachment import AttachmentResponse
from app.schemas.message import MessageResponse
from app.services.auth_service import get_current_user
from app.services.chat_service import check_membership, format_message
from app.services.storage_service import save_uploaded_file
from app.websocket.manager import manager

router = APIRouter(tags=["attachments"])

@router.post("/api/conversations/{conversation_id}/attachments", response_model=MessageResponse, status_code=status.HTTP_201_CREATED)
async def upload_attachment(
    conversation_id: str,
    file: UploadFile = File(...),
    caption: str = "",
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    check_membership(conversation_id, current_user.id, db)

    stored_name, orig_name, file_size, mime_type = await save_uploaded_file(file)

    # Create parent message for attachment
    msg_text = caption.strip() if caption.strip() else f"Shared file: {orig_name}"
    msg = Message(
        conversation_id=conversation_id,
        sender_id=current_user.id,
        text=msg_text,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow()
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)

    # Create attachment record
    attachment = Attachment(
        message_id=msg.id,
        conversation_id=conversation_id,
        user_id=current_user.id,
        file_name=stored_name,
        original_name=orig_name,
        mime_type=mime_type,
        file_size=file_size,
        duration_seconds=0,
        storage_path=os.path.join(settings.UPLOAD_DIR, stored_name),
        created_at=datetime.utcnow()
    )
    db.add(attachment)
    db.commit()
    db.refresh(msg)

    # Update conversation timestamp
    conv = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    if conv:
        conv.updated_at = datetime.utcnow()
        db.commit()

    formatted = format_message(msg, current_user.id, db)

    # Broadcast via websocket
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

@router.post("/api/conversations/{conversation_id}/voice", response_model=MessageResponse, status_code=status.HTTP_201_CREATED)
async def upload_voice_message(
    conversation_id: str,
    audio: UploadFile = File(...),
    duration: int = Form(0),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Saves an authentic recorded voice message with duration and attaches it to the conversation.
    """
    check_membership(conversation_id, current_user.id, db)

    stored_name, orig_name, file_size, mime_type = await save_uploaded_file(
        audio, expected_family="audio", max_size_bytes=settings.MAX_VOICE_SIZE_BYTES
    )

    # Format voice label
    mins = duration // 60
    secs = duration % 60
    dur_label = f"{mins}:{secs:02d}"
    msg_text = f"🎤 Voice Message ({dur_label})"

    msg = Message(
        conversation_id=conversation_id,
        sender_id=current_user.id,
        text=msg_text,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow()
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)

    attachment = Attachment(
        message_id=msg.id,
        conversation_id=conversation_id,
        user_id=current_user.id,
        file_name=stored_name,
        original_name=orig_name or f"voice_{msg.id}.webm",
        mime_type=mime_type if "audio" in mime_type else "audio/webm",
        file_size=file_size,
        duration_seconds=max(1, duration),
        storage_path=os.path.join(settings.UPLOAD_DIR, stored_name),
        created_at=datetime.utcnow()
    )
    db.add(attachment)
    db.commit()
    db.refresh(msg)

    conv = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    if conv:
        conv.updated_at = datetime.utcnow()
        db.commit()

    formatted = format_message(msg, current_user.id, db)

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

@router.get("/api/attachments/{attachment_id}/download")
def download_attachment(
    attachment_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    attachment = db.query(Attachment).filter(Attachment.id == attachment_id).first()
    if not attachment:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Attachment not found.")

    # Security check: User must be a member of the conversation to download
    check_membership(attachment.conversation_id, current_user.id, db)

    file_path = os.path.join(settings.UPLOAD_DIR, attachment.file_name)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File on disk not found.")

    return FileResponse(
        path=file_path,
        media_type=attachment.mime_type,
        filename=attachment.original_name
    )
