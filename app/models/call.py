import uuid
from datetime import datetime
from sqlalchemy import Column, String, Integer, DateTime, ForeignKey, Index
from sqlalchemy.orm import relationship
from app.core.database import Base

def generate_uuid() -> str:
    return str(uuid.uuid4())

class CallRecord(Base):
    __tablename__ = "call_records"
    __table_args__ = (
        Index("idx_call_caller_created", "caller_id", "created_at"),
        Index("idx_call_receiver_created", "receiver_id", "created_at"),
    )

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    caller_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    receiver_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    conversation_id = Column(String(36), ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True)
    call_type = Column(String(20), default="audio", nullable=False)  # "audio" or "video"
    status = Column(String(20), default="completed", nullable=False)  # "completed", "missed", "rejected", "cancelled", "busy"
    duration_seconds = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    ended_at = Column(DateTime, default=datetime.utcnow)

    caller = relationship("User", foreign_keys=[caller_id])
    receiver = relationship("User", foreign_keys=[receiver_id])
