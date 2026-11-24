"""Personal GIF and sticker collection: each user keeps their own saved items."""
import uuid
from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, String

from app.core.database import Base


def generate_uuid() -> str:
    return str(uuid.uuid4())


class SavedMedia(Base):
    __tablename__ = "saved_media"

    id = Column(String(36), primary_key=True, default=generate_uuid)
    owner_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    file_url = Column(String(500), nullable=False)
    mime_type = Column(String(100), nullable=False)
    original_name = Column(String(200), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
