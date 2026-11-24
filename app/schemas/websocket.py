from pydantic import BaseModel
from typing import Optional, Dict, Any

class WSInboundEvent(BaseModel):
    action: str  # "send_message", "typing", "read_receipt", "react", "pin"
    conversation_id: Optional[str] = None
    data: Dict[str, Any] = {}

class WSOutboundEvent(BaseModel):
    event: str
    data: Dict[str, Any]
