from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from datetime import datetime

class BanUserRequest(BaseModel):
    reason: str = Field(..., min_length=3, max_length=500)
    duration_hours: Optional[int] = None  # None = permanent

class UnbanUserRequest(BaseModel):
    reason: Optional[str] = "Pardoned by administrator"

class ChangeRoleRequest(BaseModel):
    new_role: str = Field(..., pattern="^(owner|moderator|support|user)$")
    reason: Optional[str] = "Role reassignment"

class WarnUserRequest(BaseModel):
    reason: str = Field(..., min_length=3, max_length=500)

class RevokeSessionsRequest(BaseModel):
    reason: Optional[str] = "Security session revocation"

class AuditInspectRequest(BaseModel):
    reason: str = Field(..., min_length=5, max_length=500, description="Mandatory justification reason for reviewing message content")

class AnnouncementRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=500)

class CreateReportRequest(BaseModel):
    reported_user_id: str
    conversation_id: Optional[str] = None
    message_id: Optional[str] = None
    reason_category: str = Field(..., pattern="^(spam|harassment|impersonation|illegal|other)$")
    description: Optional[str] = None

class ResolveReportRequest(BaseModel):
    action: str = Field(..., pattern="^(resolve_dismiss|resolve_ban|resolve_warn|resolve_delete_message)$")
    notes: Optional[str] = None

class PlatformMetricsResponse(BaseModel):
    total_users: int
    active_users: int
    total_messages: int
    total_conversations: int
    pending_reports: int
    media_files: int
    storage_mb: float
    role_distribution: Dict[str, int]
    daily_messages_history: List[Dict[str, Any]]

class AuditLogResponse(BaseModel):
    id: str
    actor_id: Optional[str]
    actor_username: str
    action: str
    target_type: str
    target_id: Optional[str]
    reason: Optional[str]
    metadata_json: Optional[str]
    ip_address: Optional[str]
    created_at: datetime

    class Config:
        from_attributes = True

class ModerationReportResponse(BaseModel):
    id: str
    reporter_id: str
    reporter_username: Optional[str] = None
    reported_user_id: str
    reported_username: Optional[str] = None
    conversation_id: Optional[str]
    message_id: Optional[str]
    message_snippet: Optional[str]
    reason_category: str
    description: Optional[str]
    status: str
    reviewer_id: Optional[str]
    resolution_notes: Optional[str]
    created_at: datetime
    resolved_at: Optional[datetime]

    class Config:
        from_attributes = True
