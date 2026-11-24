from pydantic import BaseModel, ConfigDict
from typing import Optional
from datetime import datetime
from app.schemas.user import UserResponse

class CallRecordResponse(BaseModel):
    id: str
    caller_id: str
    receiver_id: str
    caller: Optional[UserResponse] = None
    receiver: Optional[UserResponse] = None
    conversation_id: Optional[str] = None
    call_type: str  # "audio" or "video"
    status: str     # "completed", "missed", "rejected", "cancelled", "busy"
    duration_seconds: int = 0
    created_at: datetime
    ended_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)

class CallInitiateRequest(BaseModel):
    target_user_id: str
    call_type: str = "audio"  # "audio" or "video"
    conversation_id: Optional[str] = None
