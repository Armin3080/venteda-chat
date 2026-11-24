from pydantic import BaseModel, Field
from typing import Optional, List, Dict
from datetime import datetime
from app.schemas.user import UserResponse
from app.schemas.attachment import AttachmentResponse

class ReactionSummary(BaseModel):
    emoji: str
    count: int
    user_ids: List[str]

class MessageCreate(BaseModel):
    conversation_id: str
    text: str = Field(..., max_length=10000)
    client_msg_id: Optional[str] = None
    reply_to_id: Optional[str] = None
    forwarded_from_id: Optional[str] = None

class MessageUpdate(BaseModel):
    text: str = Field(..., min_length=1, max_length=10000)

class MessageReplyPreview(BaseModel):
    id: str
    text: str
    sender_name: str

class MessageResponse(BaseModel):
    id: str
    client_msg_id: Optional[str] = None
    conversation_id: str
    sender_id: str
    sender: Optional[UserResponse] = None
    text: str
    reply_to_id: Optional[str] = None
    reply_preview: Optional[MessageReplyPreview] = None
    forwarded_from_id: Optional[str] = None
    forwarded_from_title: Optional[str] = None
    is_edited: bool = False
    is_pinned: bool = False
    created_at: datetime
    updated_at: datetime
    attachments: List[AttachmentResponse] = []
    reactions: List[ReactionSummary] = []
    is_read_by_recipient: bool = False

    class Config:
        from_attributes = True

class ReactionToggle(BaseModel):
    emoji: str = Field(..., min_length=1, max_length=16)

class PinToggle(BaseModel):
    is_pinned: bool
