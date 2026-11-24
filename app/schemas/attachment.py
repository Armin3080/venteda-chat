from pydantic import BaseModel, ConfigDict
from typing import Optional
from datetime import datetime

class AttachmentResponse(BaseModel):
    id: str
    message_id: str
    file_name: str
    original_name: str
    mime_type: str
    file_size: int
    duration_seconds: Optional[int] = 0
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
