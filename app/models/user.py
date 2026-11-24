import uuid
from datetime import datetime
from sqlalchemy import Column, String, Boolean, DateTime, Text, Integer, ForeignKey
from sqlalchemy.orm import relationship
from app.core.database import Base

def generate_uuid() -> str:
    return str(uuid.uuid4())

class User(Base):
    __tablename__ = "users"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    display_name = Column(String(100), nullable=False)
    email = Column(String(255), unique=True, index=True, nullable=True)
    password_hash = Column(String(255), nullable=False)
    avatar_url = Column(String(500), nullable=True)
    bio = Column(String(255), nullable=True)
    role = Column(String(20), default="user", nullable=False)  # "owner", "moderator", "support", "user"
    connect_code = Column(String(32), unique=True, index=True, nullable=True)
    privacy_mode = Column(String(20), default="strict")  # "strict" (requires connect code) or "discoverable"
    is_banned = Column(Boolean, default=False)
    is_active = Column(Boolean, default=True, nullable=False)  # admins can deactivate an account
    ban_reason = Column(Text, nullable=True)
    ban_expires_at = Column(DateTime, nullable=True)
    warning_count = Column(Integer, default=0)
    is_online = Column(Boolean, default=False)
    last_seen = Column(DateTime, default=datetime.utcnow)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    memberships = relationship("ConversationMember", back_populates="user", cascade="all, delete-orphan")
    messages = relationship("Message", back_populates="sender", cascade="all, delete-orphan", foreign_keys="Message.sender_id")
    settings = relationship("UserSettings", back_populates="user", uselist=False, cascade="all, delete-orphan")
    reactions = relationship("MessageReaction", back_populates="user", cascade="all, delete-orphan")
    sessions = relationship("UserSession", back_populates="user", cascade="all, delete-orphan")

class UserSession(Base):
    __tablename__ = "user_sessions"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_jti = Column(String(64), nullable=False, index=True)
    device_name = Column(String(100), default="Desktop Web")
    browser = Column(String(100), default="Chrome / Firefox")
    ip_address = Column(String(45), default="127.0.0.1")
    is_revoked = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_active_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="sessions")

class UserSettings(Base):
    __tablename__ = "user_settings"

    id = Column(String(36), primary_key=True, default=generate_uuid)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False)
    theme = Column(String(20), default="dark")  # "light", "dark", "system"
    language = Column(String(10), default="en")  # "en" or "fa"
    notifications_enabled = Column(Boolean, default=True)
    sound_enabled = Column(Boolean, default=True)
    enter_is_send = Column(Boolean, default=True)
    wallpaper = Column(String(50), default="mesh")  # "mesh", "frosted", "midnight", "aurora", "plain"
    glass_intensity = Column(String(20), default="balanced")  # "subtle", "balanced", "frosted"
    accent_color = Column(String(20), default="#2685F6")
    bubble_style = Column(String(20), default="soft")  # "soft", "sharp", "glass"
    font_scale = Column(String(20), default="medium")  # "small", "medium", "large"
    dnd_enabled = Column(Boolean, default=False)
    dnd_start_hour = Column(Integer, default=22)
    dnd_end_hour = Column(Integer, default=8)
    media_auto_download = Column(Boolean, default=True)
    compact_mode = Column(Boolean, default=False)
    reduced_motion = Column(Boolean, default=False)
    high_contrast = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User", back_populates="settings")
