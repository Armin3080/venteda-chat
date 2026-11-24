import uuid
from datetime import datetime
from sqlalchemy import Column, String, Boolean, DateTime, Text, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship
from app.core.database import Base

def generate_uuid() -> str:
    return str(uuid.uuid4())

class Conversation(Base):
    __tablename__ = "conversations"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    type = Column(String(20), nullable=False, default="direct") # "direct" or "group"
    title = Column(String(100), nullable=True) # For groups
    description = Column(Text, nullable=True)
    avatar_url = Column(String(500), nullable=True)
    created_by_id = Column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    pinned_message_id = Column(String(36), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    members = relationship("ConversationMember", back_populates="conversation", cascade="all, delete-orphan")
    messages = relationship("Message", back_populates="conversation", cascade="all, delete-orphan")

class ConversationMember(Base):
    __tablename__ = "conversation_members"
    __table_args__ = (
        UniqueConstraint("conversation_id", "user_id", name="uq_conv_user"),
    )

    id = Column(String(36), primary_key=True, default=generate_uuid)
    conversation_id = Column(String(36), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    role = Column(String(20), default="member") # "owner", "admin", "member"
    is_muted = Column(Boolean, default=False)
    last_read_message_id = Column(String(36), nullable=True)
    joined_at = Column(DateTime, default=datetime.utcnow)

    conversation = relationship("Conversation", back_populates="members")
    user = relationship("User", back_populates="memberships")
