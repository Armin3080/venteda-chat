from typing import List, Optional

from pydantic import BaseModel, Field

from app.schemas.user import UserResponse


class ContactUpdate(BaseModel):
    nickname: Optional[str] = Field(None, max_length=100)
    is_saved: Optional[bool] = None
    notifications_muted: Optional[bool] = None
    is_blocked: Optional[bool] = None


class ContactResponse(BaseModel):
    user_id: str
    username: str
    display_name: str
    nickname: Optional[str] = None
    is_saved: bool = False
    notifications_muted: bool = False
    is_blocked: bool = False


class RelationshipResponse(BaseModel):
    is_saved: bool = False
    nickname: Optional[str] = None
    notifications_muted: bool = False
    is_blocked: bool = False


class SharedGroupResponse(BaseModel):
    id: str
    title: Optional[str] = None
    member_count: int = 0


class ProfileResponse(BaseModel):
    user: UserResponse
    relationship: RelationshipResponse
    shared_groups: List[SharedGroupResponse] = []
    stories_count: int = 0
