from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.models.user import User
from app.models.message import Message
from app.models.admin import ModerationReport
from app.schemas.admin import CreateReportRequest, ModerationReportResponse
from app.services.auth_service import get_current_user

router = APIRouter(prefix="/api/reports", tags=["reports"])

@router.post("", response_model=ModerationReportResponse, status_code=status.HTTP_201_CREATED)
def submit_report(
    req: CreateReportRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    reported_user = db.query(User).filter(User.id == req.reported_user_id).first()
    if not reported_user:
        raise HTTPException(status_code=404, detail="Reported user not found.")

    snippet = None
    if req.message_id:
        msg = db.query(Message).filter(Message.id == req.message_id).first()
        if msg:
            snippet = msg.text[:100]

    report = ModerationReport(
        reporter_id=current_user.id,
        reported_user_id=req.reported_user_id,
        conversation_id=req.conversation_id,
        message_id=req.message_id,
        message_snippet=snippet,
        reason_category=req.reason_category,
        description=req.description,
        status="pending"
    )
    db.add(report)
    db.commit()
    db.refresh(report)

    return ModerationReportResponse(
        id=report.id,
        reporter_id=report.reporter_id,
        reporter_username=current_user.username,
        reported_user_id=report.reported_user_id,
        reported_username=reported_user.username,
        conversation_id=report.conversation_id,
        message_id=report.message_id,
        message_snippet=report.message_snippet,
        reason_category=report.reason_category,
        description=report.description,
        status=report.status,
        reviewer_id=None,
        resolution_notes=None,
        created_at=report.created_at,
        resolved_at=None
    )
