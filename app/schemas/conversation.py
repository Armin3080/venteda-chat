from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime
from app.schemas.user import UserResponse
from app.schemas.message import MessageResponse

class ConversationMemberResponse(BaseModel):
    id: str
    user_id: str
    user: UserResponse
    role: str
    is_muted: bool = False
    last_read_message_id: Optional[str] = None
    joined_at: datetime

    class Config:
        from_attributes = True

class ConversationCreate(BaseModel):
    type: str = "direct"  # "direct" or "group"
    recipient_id: Optional[str] = None  # for direct
    title: Optional[str] = Field(None, max_length=100)  # for group
    description: Optional[str] = None
    member_ids: Optional[List[str]] = []  # for group

class ConversationResponse(BaseModel):
    id: str
    type: str
    title: Optional[str] = None
    description: Optional[str] = None
    avatar_url: Optional[str] = None
    created_by_id: Optional[str] = None
    pinned_message_id: Optional[str] = None
    pinned_message: Optional[MessageResponse] = None
    last_message: Optional[MessageResponse] = None
    unread_count: int = 0
    is_muted: bool = False
    members: List[ConversationMemberResponse] = []
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

class GroupUpdateRequest(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)

class AddMembersRequest(BaseModel):
    user_ids: List[str]

class MemberRoleUpdate(BaseModel):
    role: str = Field(..., pattern="^(admin|member)$")
