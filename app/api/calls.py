from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import desc, or_
from typing import List
from datetime import datetime

from app.core.database import get_db
from app.core.config import settings
from app.models.user import User
from app.models.call import CallRecord
from app.schemas.call import CallRecordResponse, CallInitiateRequest
from app.services.auth_service import get_current_user

router = APIRouter(prefix="/api/calls", tags=["calls"])

@router.get("/config")
def get_webrtc_config(current_user: User = Depends(get_current_user)):
    """
    Returns public ICE servers configuration (STUN/TURN) for WebRTC connections.
    """
    ice_servers = [
        {"urls": settings.STUN_SERVER}
    ]
    if settings.TURN_SERVER:
        turn_entry = {"urls": settings.TURN_SERVER}
        if settings.TURN_USERNAME:
            turn_entry["username"] = settings.TURN_USERNAME
        if settings.TURN_CREDENTIAL:
            turn_entry["credential"] = settings.TURN_CREDENTIAL
        ice_servers.append(turn_entry)

    return {
        "ice_servers": ice_servers,
        "stun_server": settings.STUN_SERVER,
        "turn_configured": bool(settings.TURN_SERVER)
    }

@router.get("/history", response_model=List[CallRecordResponse])
def get_call_history(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Returns call history for current user.
    """
    records = db.query(CallRecord).filter(
        or_(
            CallRecord.caller_id == current_user.id,
            CallRecord.receiver_id == current_user.id
        )
    ).order_by(desc(CallRecord.created_at)).limit(50).all()
    
    return [CallRecordResponse.model_validate(r) for r in records]
