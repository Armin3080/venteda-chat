"""Per-user relationship settings: saved contacts, nicknames, notification mute, blocking."""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, String, UniqueConstraint

from app.core.database import Base


def generate_uuid() -> str:
    return str(uuid.uuid4())


class UserContact(Base):
    """One row describes what owner_id has set about target_id. Only owner_id sees these settings."""
    __tablename__ = "user_contacts"
    __table_args__ = (UniqueConstraint("owner_id", "target_id", name="uq_user_contact_owner_target"),)

    id = Column(String(36), primary_key=True, default=generate_uuid)
    owner_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    target_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    nickname = Column(String(100), nullable=True)
    is_saved = Column(Boolean, default=False, nullable=False)
    notifications_muted = Column(Boolean, default=False, nullable=False)
    is_blocked = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
