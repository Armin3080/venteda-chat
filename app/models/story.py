"""Stories: photo or video posts that disappear after 24 hours."""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, String, Text, UniqueConstraint

from app.core.database import Base


def generate_uuid() -> str:
    return str(uuid.uuid4())


class Story(Base):
    __tablename__ = "stories"

    id = Column(String(36), primary_key=True, default=generate_uuid)
    author_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    media_url = Column(String(500), nullable=False)
    media_type = Column(String(10), nullable=False)  # "image" or "video"
    caption = Column(Text, nullable=True)
    is_platform = Column(Boolean, default=False, nullable=False)  # published by staff for everyone
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    expires_at = Column(DateTime, nullable=False, index=True)


class StoryView(Base):
    __tablename__ = "story_views"
    __table_args__ = (UniqueConstraint("story_id", "viewer_id", name="uq_story_view"),)

    id = Column(String(36), primary_key=True, default=generate_uuid)
    story_id = Column(String(36), ForeignKey("stories.id", ondelete="CASCADE"), nullable=False, index=True)
    viewer_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    viewed_at = Column(DateTime, default=datetime.utcnow)
