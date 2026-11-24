import uuid
from datetime import datetime
from sqlalchemy import Column, String, Boolean, DateTime, Text, ForeignKey, Index
from sqlalchemy.orm import relationship
from app.core.database import Base

def generate_uuid() -> str:
    return str(uuid.uuid4())

class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        Index("idx_conv_created", "conversation_id", "created_at"),
        Index("idx_client_msg_id", "client_msg_id"),
    )

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    client_msg_id = Column(String(64), nullable=True, index=True) # deduplication key
    conversation_id = Column(String(36), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    sender_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    text = Column(Text, nullable=False, default="")
    reply_to_id = Column(String(36), ForeignKey("messages.id", ondelete="SET NULL"), nullable=True)
    forwarded_from_id = Column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    forwarded_from_title = Column(String(100), nullable=True)
    is_edited = Column(Boolean, default=False)
    is_pinned = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    conversation = relationship("Conversation", back_populates="messages")
    sender = relationship("User", foreign_keys=[sender_id], back_populates="messages")
    forwarded_from = relationship("User", foreign_keys=[forwarded_from_id])
    attachments = relationship("Attachment", back_populates="message", cascade="all, delete-orphan")
    reactions = relationship("MessageReaction", back_populates="message", cascade="all, delete-orphan")
    reply_to = relationship("Message", remote_side=[id], foreign_keys=[reply_to_id], backref="replies")

class MessageReaction(Base):
    __tablename__ = "message_reactions"

    id = Column(String(36), primary_key=True, default=generate_uuid)
    message_id = Column(String(36), ForeignKey("messages.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    emoji = Column(String(16), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    message = relationship("Message", back_populates="reactions")
    user = relationship("User", back_populates="reactions")
