from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class StoryResponse(BaseModel):
    id: str
    author_id: str
    media_url: str
    media_type: str
    caption: Optional[str] = None
    created_at: datetime
    expires_at: datetime
    is_platform: bool = False
    viewed: bool = False
    view_count: Optional[int] = None  # only sent to the author


class StoryFeedItem(BaseModel):
    user_id: str
    display_name: str
    avatar_url: Optional[str] = None
    count: int
    unseen: bool
    latest_at: datetime
    is_me: bool = False
    is_platform: bool = False


class StoryViewerResponse(BaseModel):
    user_id: str
    username: str
    display_name: str
    avatar_url: Optional[str] = None
    viewed_at: datetime
