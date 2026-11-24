import uuid
from datetime import datetime
from sqlalchemy import Column, String, Integer, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from app.core.database import Base

def generate_uuid() -> str:
    return str(uuid.uuid4())

class Attachment(Base):
    __tablename__ = "attachments"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    message_id = Column(String(36), ForeignKey("messages.id", ondelete="CASCADE"), nullable=False, index=True)
    conversation_id = Column(String(36), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    file_name = Column(String(255), nullable=False)
    original_name = Column(String(255), nullable=False)
    mime_type = Column(String(100), nullable=False)
    file_size = Column(Integer, nullable=False)
    storage_path = Column(String(500), nullable=False)
    duration_seconds = Column(Integer, nullable=True, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)

    message = relationship("Message", back_populates="attachments")
