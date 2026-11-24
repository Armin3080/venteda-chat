import uuid
from datetime import datetime
from sqlalchemy import Column, String, DateTime, Text, ForeignKey, Index
from sqlalchemy.orm import relationship
from app.core.database import Base

def generate_uuid() -> str:
    return str(uuid.uuid4())

class AuditLog(Base):
    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("idx_audit_actor_created", "actor_id", "created_at"),
        Index("idx_audit_action_created", "action", "created_at"),
    )

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    actor_id = Column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    actor_username = Column(String(50), nullable=False)
    action = Column(String(50), nullable=False, index=True)  # e.g. "USER_BAN", "USER_UNBAN", "ROLE_CHANGE", "CONTENT_INSPECT", "REPORT_RESOLVE", "SESSION_REVOKE"
    target_type = Column(String(30), nullable=False)  # "user", "conversation", "message", "report", "system"
    target_id = Column(String(64), nullable=True, index=True)
    reason = Column(Text, nullable=True)  # Mandatory for content inspect and bans
    metadata_json = Column(Text, nullable=True)
    ip_address = Column(String(45), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True, nullable=False)

    actor = relationship("User", foreign_keys=[actor_id])

class ModerationReport(Base):
    __tablename__ = "moderation_reports"
    __table_args__ = (
        Index("idx_report_status_created", "status", "created_at"),
    )

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    reporter_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    reported_user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    conversation_id = Column(String(36), ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True)
    message_id = Column(String(36), ForeignKey("messages.id", ondelete="SET NULL"), nullable=True)
    message_snippet = Column(String(255), nullable=True)
    reason_category = Column(String(50), nullable=False)  # "spam", "harassment", "impersonation", "illegal", "other"
    description = Column(Text, nullable=True)
    status = Column(String(20), default="pending", nullable=False)  # "pending", "under_review", "resolved", "dismissed"
    reviewer_id = Column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    resolution_notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    resolved_at = Column(DateTime, nullable=True)

    reporter = relationship("User", foreign_keys=[reporter_id])
    reported_user = relationship("User", foreign_keys=[reported_user_id])
    reviewer = relationship("User", foreign_keys=[reviewer_id])
