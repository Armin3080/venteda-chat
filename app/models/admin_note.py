"""Private notes that staff write about a user. Never exposed through user-facing APIs."""
import uuid
from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, String, Text

from app.core.database import Base


class AdminNote(Base):
    __tablename__ = "admin_notes"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    author_id = Column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    author_username = Column(String(50), nullable=False)
    text = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
