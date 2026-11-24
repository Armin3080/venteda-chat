import json
from datetime import datetime, timedelta
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status, Request
from sqlalchemy.orm import Session
from sqlalchemy import func, or_, desc

from app.core.database import get_db
from app.models.user import User, UserSession
from app.models.conversation import Conversation, ConversationMember
from app.models.message import Message
from app.models.attachment import Attachment
from app.models.admin import AuditLog, ModerationReport
from app.schemas.user import UserAdminResponse
from app.schemas.admin import (
    PlatformMetricsResponse,
    BanUserRequest,
    UnbanUserRequest,
    ChangeRoleRequest,
    WarnUserRequest,
    RevokeSessionsRequest,
    AuditInspectRequest,
    ResolveReportRequest,
    AuditLogResponse,
    ModerationReportResponse,
    AnnouncementRequest
)
from app.services.auth_service import (
    get_current_user,
    require_owner,
    require_moderator_or_higher,
    require_staff
)
from app.websocket.manager import manager

router = APIRouter(prefix="/api/admin", tags=["admin"])

def create_audit_entry(
    db: Session,
    actor: User,
    action: str,
    target_type: str,
    target_id: Optional[str],
    reason: Optional[str] = None,
    metadata: Optional[dict] = None,
    ip_address: Optional[str] = None
) -> AuditLog:
    entry = AuditLog(
        actor_id=actor.id,
        actor_username=actor.username,
        action=action,
        target_type=target_type,
        target_id=str(target_id) if target_id else None,
        reason=reason,
        metadata_json=json.dumps(metadata) if metadata else None,
        ip_address=ip_address
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry

@router.get("/metrics", response_model=PlatformMetricsResponse)
def get_platform_metrics(
    current_user: User = Depends(require_staff),
    db: Session = Depends(get_db)
):
    total_users = db.query(func.count(User.id)).scalar() or 0
    active_users = db.query(func.count(User.id)).filter(User.is_online == True).scalar() or 0
    total_messages = db.query(func.count(Message.id)).scalar() or 0
    total_conversations = db.query(func.count(Conversation.id)).scalar() or 0
    pending_reports = db.query(func.count(ModerationReport.id)).filter(ModerationReport.status == "pending").scalar() or 0
    media_files = db.query(func.count(Attachment.id)).scalar() or 0
    
    # Calculate storage
    total_bytes = db.query(func.sum(Attachment.file_size)).scalar() or 0
    storage_mb = round(total_bytes / (1024 * 1024), 2)

    # Roles distribution
    role_counts = db.query(User.role, func.count(User.id)).group_by(User.role).all()
    role_dist = {r: c for r, c in role_counts}

    # Daily message volume history for last 7 days
    now = datetime.utcnow()
    daily_history = []
    for i in range(6, -1, -1):
        day_start = (now - timedelta(days=i)).replace(hour=0, minute=0, second=0, microsecond=0)
        day_end = day_start + timedelta(days=1)
        cnt = db.query(func.count(Message.id)).filter(
            Message.created_at >= day_start,
            Message.created_at < day_end
        ).scalar() or 0
        daily_history.append({
            "date": day_start.strftime("%Y-%m-%d"),
            "label": day_start.strftime("%b %d"),
            "messages": cnt
        })

    return PlatformMetricsResponse(
        total_users=total_users,
        active_users=active_users,
        total_messages=total_messages,
        total_conversations=total_conversations,
        pending_reports=pending_reports,
        media_files=media_files,
        storage_mb=storage_mb,
        role_distribution=role_dist,
        daily_messages_history=daily_history
    )

@router.get("/users", response_model=List[UserAdminResponse])
def list_admin_users(
    query: Optional[str] = Query(None),
    role: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    skip: int = 0,
    limit: int = 100,
    current_user: User = Depends(require_staff),
    db: Session = Depends(get_db)
):
    q = db.query(User)
    if query:
        search_pattern = f"%{query.strip().lower()}%"
        q = q.filter(
            or_(
                User.username.ilike(search_pattern),
                User.display_name.ilike(search_pattern),
                User.email.ilike(search_pattern),
                User.connect_code.ilike(search_pattern)
            )
        )
    if role and role != "all":
        q = q.filter(User.role == role)
    if status:
        if status == "banned":
            q = q.filter(User.is_banned == True)
        elif status == "active":
            q = q.filter(User.is_banned == False)

    users = q.order_by(desc(User.created_at)).offset(skip).limit(limit).all()
    return [UserAdminResponse.from_orm(u) for u in users]

@router.post("/users/{user_id}/ban")
async def ban_user(
    user_id: str,
    req: BanUserRequest,
    request: Request,
    current_user: User = Depends(require_moderator_or_higher),
    db: Session = Depends(get_db)
):
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found.")

    if target.role == "owner":
        raise HTTPException(status_code=403, detail="The owner cannot be banned.")
    if target.role in ["moderator", "support"] and current_user.role != "owner":
        raise HTTPException(status_code=403, detail="Only the owner can ban staff members.")

    expires_at = None
    if req.duration_hours and req.duration_hours > 0:
        expires_at = datetime.utcnow() + timedelta(hours=req.duration_hours)

    target.is_banned = True
    target.ban_reason = req.reason.strip()
    target.ban_expires_at = expires_at
    target.is_online = False

    # Revoke sessions
    db.query(UserSession).filter(UserSession.user_id == target.id).update({"is_revoked": True})
    db.commit()

    # Disconnect active WebSockets immediately
    await manager.disconnect_user(target.id)

    # Append to immutable audit log
    client_ip = request.client.host if request.client else "unknown"
    create_audit_entry(
        db=db,
        actor=current_user,
        action="USER_BAN",
        target_type="user",
        target_id=target.id,
        reason=req.reason.strip(),
        metadata={"duration_hours": req.duration_hours, "target_username": target.username},
        ip_address=client_ip
    )

    return {"message": f"User @{target.username} has been suspended.", "user_id": target.id}

@router.post("/users/{user_id}/unban")
def unban_user(
    user_id: str,
    req: UnbanUserRequest,
    request: Request,
    current_user: User = Depends(require_moderator_or_higher),
    db: Session = Depends(get_db)
):
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found.")

    target.is_banned = False
    target.ban_reason = None
    target.ban_expires_at = None
    db.commit()

    client_ip = request.client.host if request.client else "unknown"
    create_audit_entry(
        db=db,
        actor=current_user,
        action="USER_UNBAN",
        target_type="user",
        target_id=target.id,
        reason=req.reason,
        metadata={"target_username": target.username},
        ip_address=client_ip
    )

    return {"message": f"User @{target.username} has been unbanned.", "user_id": target.id}

@router.post("/users/{user_id}/role")
def change_user_role(
    user_id: str,
    req: ChangeRoleRequest,
    request: Request,
    current_user: User = Depends(require_owner),  # Strictly owner only
    db: Session = Depends(get_db)
):
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found.")

    old_role = target.role
    if old_role == "owner" and target.id != current_user.id:
        raise HTTPException(status_code=403, detail="Cannot demote another owner.")

    target.role = req.new_role
    db.commit()

    client_ip = request.client.host if request.client else "unknown"
    create_audit_entry(
        db=db,
        actor=current_user,
        action="ROLE_CHANGE",
        target_type="user",
        target_id=target.id,
        reason=req.reason,
        metadata={"target_username": target.username, "old_role": old_role, "new_role": req.new_role},
        ip_address=client_ip
    )

    return {"message": f"User @{target.username} role updated to {req.new_role}."}

@router.post("/users/{user_id}/warn")
def warn_user(
    user_id: str,
    req: WarnUserRequest,
    request: Request,
    current_user: User = Depends(require_moderator_or_higher),
    db: Session = Depends(get_db)
):
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found.")

    target.warning_count = (target.warning_count or 0) + 1
    db.commit()

    client_ip = request.client.host if request.client else "unknown"
    create_audit_entry(
        db=db,
        actor=current_user,
        action="USER_WARN",
        target_type="user",
        target_id=target.id,
        reason=req.reason,
        metadata={"target_username": target.username, "new_warning_count": target.warning_count},
        ip_address=client_ip
    )

    return {"message": f"Warning issued to @{target.username}.", "warning_count": target.warning_count}

@router.post("/users/{user_id}/revoke-sessions")
async def revoke_user_sessions(
    user_id: str,
    req: RevokeSessionsRequest,
    request: Request,
    current_user: User = Depends(require_moderator_or_higher),
    db: Session = Depends(get_db)
):
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found.")

    db.query(UserSession).filter(UserSession.user_id == target.id).update({"is_revoked": True})
    target.is_online = False
    db.commit()

    await manager.disconnect_user(target.id)

    client_ip = request.client.host if request.client else "unknown"
    create_audit_entry(
        db=db,
        actor=current_user,
        action="SESSION_REVOKE",
        target_type="user",
        target_id=target.id,
        reason=req.reason,
        metadata={"target_username": target.username},
        ip_address=client_ip
    )

    return {"message": f"All active sessions for @{target.username} have been revoked."}

@router.get("/conversations")
def list_admin_conversations(
    current_user: User = Depends(require_staff),
    db: Session = Depends(get_db)
):
    convs = db.query(Conversation).order_by(desc(Conversation.updated_at)).limit(100).all()
    results = []
    for c in convs:
        msg_count = db.query(func.count(Message.id)).filter(Message.conversation_id == c.id).scalar() or 0
        member_count = db.query(func.count(ConversationMember.id)).filter(ConversationMember.conversation_id == c.id).scalar() or 0
        results.append({
            "id": c.id,
            "type": c.type,
            "title": c.title or "Direct Conversation",
            "member_count": member_count,
            "message_count": msg_count,
            "created_at": c.created_at.isoformat() if c.created_at else None,
            "updated_at": c.updated_at.isoformat() if c.updated_at else None
        })
    return results

@router.post("/conversations/{conv_id}/audit-inspect")
def inspect_conversation(
    conv_id: str,
    req: AuditInspectRequest,
    request: Request,
    current_user: User = Depends(require_moderator_or_higher),
    db: Session = Depends(get_db)
):
    # Mandatory justification required to audit chat content
    if not req.reason or len(req.reason.strip()) < 5:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A mandatory justification reason (min 5 characters) is required to inspect conversations."
        )

    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found.")

    client_ip = request.client.host if request.client else "unknown"
    # Log this audited access to immutable audit log BEFORE returning messages
    create_audit_entry(
        db=db,
        actor=current_user,
        action="CONTENT_INSPECT",
        target_type="conversation",
        target_id=conv.id,
        reason=req.reason.strip(),
        metadata={"conversation_title": conv.title, "conversation_type": conv.type},
        ip_address=client_ip
    )

    # Return messages for review
    messages = db.query(Message).filter(Message.conversation_id == conv.id).order_by(desc(Message.created_at)).limit(50).all()
    return {
        "conversation_id": conv.id,
        "title": conv.title,
        "type": conv.type,
        "messages": [
            {
                "id": m.id,
                "sender_id": m.sender_id,
                "sender_username": m.sender.username if m.sender else "unknown",
                "text": m.text,
                "created_at": m.created_at.isoformat() if m.created_at else None
            }
            for m in reversed(messages)
        ]
    }

@router.get("/users/{user_id}/dossier")
def get_user_dossier(
    user_id: str,
    current_user: User = Depends(require_staff),
    db: Session = Depends(get_db)
):
    """Full user dossier for admin surveillance and inspection."""
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found.")

    # Get conversation memberships
    memberships = db.query(ConversationMember).filter(ConversationMember.user_id == target.id).all()
    user_conversations = []
    for m in memberships:
        conv = db.query(Conversation).filter(Conversation.id == m.conversation_id).first()
        if not conv:
            continue
        msg_count = db.query(func.count(Message.id)).filter(Message.conversation_id == conv.id).scalar() or 0
        # Other members
        other_members = db.query(User.username, User.display_name).join(
            ConversationMember, ConversationMember.user_id == User.id
        ).filter(
            ConversationMember.conversation_id == conv.id,
            User.id != target.id
        ).all()
        other_names = [f"@{u[0]} ({u[1]})" for u in other_members]

        user_conversations.append({
            "id": conv.id,
            "type": conv.type,
            "title": conv.title or (", ".join(other_names) if other_names else "Saved Messages"),
            "role_in_conv": m.role,
            "message_count": msg_count,
            "other_members": other_names,
            "created_at": conv.created_at.isoformat() if conv.created_at else None,
            "updated_at": conv.updated_at.isoformat() if conv.updated_at else None
        })

    # Total sent messages
    total_sent = db.query(func.count(Message.id)).filter(Message.sender_id == target.id).scalar() or 0

    # Recent messages sent by this user
    recent_msgs = db.query(Message).filter(Message.sender_id == target.id).order_by(desc(Message.created_at)).limit(15).all()
    recent_messages_data = [
        {
            "id": msg.id,
            "conversation_id": msg.conversation_id,
            "text": msg.text,
            "created_at": msg.created_at.isoformat() if msg.created_at else None
        }
        for msg in recent_msgs
    ]

    # Active sessions count
    active_sessions = db.query(func.count(UserSession.id)).filter(
        UserSession.user_id == target.id,
        UserSession.is_revoked == False
    ).scalar() or 0

    return {
        "user": {
            "id": target.id,
            "username": target.username,
            "display_name": target.display_name,
            "email": target.email,
            "role": target.role,
            "avatar_url": target.avatar_url,
            "bio": target.bio,
            "connect_code": target.connect_code,
            "privacy_mode": target.privacy_mode,
            "is_banned": target.is_banned,
            "ban_reason": target.ban_reason,
            "warning_count": target.warning_count or 0,
            "is_online": target.is_online,
            "last_seen": target.last_seen.isoformat() if target.last_seen else None,
            "created_at": target.created_at.isoformat() if target.created_at else None,
        },
        "stats": {
            "total_sent_messages": total_sent,
            "conversations_count": len(user_conversations),
            "active_sessions": active_sessions
        },
        "conversations": user_conversations,
        "recent_messages": recent_messages_data
    }

@router.get("/conversations/{conv_id}/messages")
def get_conversation_messages_for_admin(
    conv_id: str,
    limit: int = 100,
    current_user: User = Depends(require_staff),
    db: Session = Depends(get_db)
):
    """Direct message history viewer for admin moderation and surveillance."""
    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found.")

    members = db.query(User).join(
        ConversationMember, ConversationMember.user_id == User.id
    ).filter(ConversationMember.conversation_id == conv.id).all()

    messages = db.query(Message).filter(Message.conversation_id == conv.id).order_by(desc(Message.created_at)).limit(limit).all()

    return {
        "conversation_id": conv.id,
        "title": conv.title,
        "type": conv.type,
        "members": [{"id": u.id, "username": u.username, "display_name": u.display_name} for u in members],
        "messages": [
            {
                "id": m.id,
                "sender_id": m.sender_id,
                "sender_username": m.sender.username if m.sender else "unknown",
                "sender_display_name": m.sender.display_name if m.sender else "Unknown",
                "text": m.text,
                "has_attachments": bool(m.attachments),
                "attachments": [
                    {
                        "id": a.id,
                        "file_name": a.file_name,
                        "original_name": a.original_name,
                        "mime_type": a.mime_type,
                        "file_size": a.file_size,
                        "url": f"/media/{a.file_name}"
                    }
                    for a in (m.attachments or [])
                ],
                "created_at": m.created_at.isoformat() if m.created_at else None
            }
            for m in reversed(messages)
        ]
    }

@router.get("/live-feed")
def get_platform_live_feed(
    limit: int = 50,
    current_user: User = Depends(require_staff),
    db: Session = Depends(get_db)
):
    """Global message surveillance feed across the entire messenger."""
    recent_msgs = db.query(Message).order_by(desc(Message.created_at)).limit(limit).all()
    feed = []
    for m in recent_msgs:
        conv = m.conversation
        feed.append({
            "id": m.id,
            "conversation_id": m.conversation_id,
            "conversation_title": conv.title if conv else "Chat",
            "conversation_type": conv.type if conv else "direct",
            "sender_id": m.sender_id,
            "sender_username": m.sender.username if m.sender else "unknown",
            "sender_display_name": m.sender.display_name if m.sender else "Unknown",
            "text": m.text,
            "has_attachments": bool(m.attachments),
            "created_at": m.created_at.isoformat() if m.created_at else None
        })
    return feed

@router.delete("/messages/{message_id}")
async def admin_delete_message(
    message_id: str,
    request: Request,
    current_user: User = Depends(require_moderator_or_higher),
    db: Session = Depends(get_db)
):
    """Super admin forced deletion of inappropriate content."""
    msg = db.query(Message).filter(Message.id == message_id).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found.")

    conv_id = msg.conversation_id
    snippet = msg.text[:80] if msg.text else "[attachment]"
    target_sender_id = msg.sender_id

    db.delete(msg)
    db.commit()

    # Tell the conversation members the message is gone
    member_ids = {r.user_id for r in db.query(ConversationMember.user_id).filter(
        ConversationMember.conversation_id == conv_id).all()}
    await manager.broadcast_to_users(
        {"event": "message_deleted", "data": {"message_id": message_id, "conversation_id": conv_id}},
        member_ids,
    )

    client_ip = request.client.host if request.client else "unknown"
    create_audit_entry(
        db=db,
        actor=current_user,
        action="ADMIN_DELETE_MESSAGE",
        target_type="message",
        target_id=message_id,
        reason="Super-admin content moderation removal",
        metadata={"conversation_id": conv_id, "sender_id": target_sender_id, "snippet": snippet},
        ip_address=client_ip
    )

    return {"message": "Message deleted by administrator.", "message_id": message_id}

@router.get("/reports", response_model=List[ModerationReportResponse])
def list_moderation_reports(
    status_filter: Optional[str] = Query(None),
    current_user: User = Depends(require_staff),
    db: Session = Depends(get_db)
):
    q = db.query(ModerationReport)
    if status_filter and status_filter != "all":
        q = q.filter(ModerationReport.status == status_filter)
    
    reports = q.order_by(desc(ModerationReport.created_at)).limit(100).all()
    results = []
    for r in reports:
        item = ModerationReportResponse(
            id=r.id,
            reporter_id=r.reporter_id,
            reporter_username=r.reporter.username if r.reporter else "unknown",
            reported_user_id=r.reported_user_id,
            reported_username=r.reported_user.username if r.reported_user else "unknown",
            conversation_id=r.conversation_id,
            message_id=r.message_id,
            message_snippet=r.message_snippet,
            reason_category=r.reason_category,
            description=r.description,
            status=r.status,
            reviewer_id=r.reviewer_id,
            resolution_notes=r.resolution_notes,
            created_at=r.created_at,
            resolved_at=r.resolved_at
        )
        results.append(item)
    return results

@router.post("/reports/{report_id}/resolve")
def resolve_report(
    report_id: str,
    req: ResolveReportRequest,
    request: Request,
    current_user: User = Depends(require_moderator_or_higher),
    db: Session = Depends(get_db)
):
    report = db.query(ModerationReport).filter(ModerationReport.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found.")

    report.status = "resolved" if req.action != "resolve_dismiss" else "dismissed"
    report.reviewer_id = current_user.id
    report.resolution_notes = req.notes or f"Action taken: {req.action}"
    report.resolved_at = datetime.utcnow()
    db.commit()

    client_ip = request.client.host if request.client else "unknown"
    create_audit_entry(
        db=db,
        actor=current_user,
        action="REPORT_RESOLVE",
        target_type="report",
        target_id=report.id,
        reason=req.notes,
        metadata={"action_type": req.action, "reported_user_id": report.reported_user_id},
        ip_address=client_ip
    )

    return {"message": "Report status updated successfully.", "status": report.status}

@router.get("/audit-logs", response_model=List[AuditLogResponse])
def get_audit_logs(
    action: Optional[str] = Query(None),
    actor: Optional[str] = Query(None),
    limit: int = 100,
    current_user: User = Depends(require_staff),
    db: Session = Depends(get_db)
):
    q = db.query(AuditLog)
    if action and action != "all":
        q = q.filter(AuditLog.action == action)
    if actor:
        q = q.filter(AuditLog.actor_username.ilike(f"%{actor}%"))

    logs = q.order_by(desc(AuditLog.created_at)).limit(limit).all()
    return [AuditLogResponse.from_orm(l) for l in logs]


@router.post("/announcements")
async def send_announcement(
    payload: AnnouncementRequest,
    request: Request,
    current_user: User = Depends(require_moderator_or_higher),
    db: Session = Depends(get_db)
):
    """Platform-wide notice, delivered to every user with an open connection."""
    text = payload.text.strip()
    online_ids = set(manager.active_users.keys())
    await manager.broadcast_to_users(
        {"event": "system_announcement", "data": {"text": text, "sender": f"@{current_user.username}"}},
        online_ids,
    )
    client_ip = request.client.host if request.client else "unknown"
    create_audit_entry(
        db=db,
        actor=current_user,
        action="BROADCAST_ANNOUNCEMENT",
        target_type="system",
        target_id=None,
        reason="Platform announcement",
        metadata={"length": len(text), "delivered_to": len(online_ids)},
        ip_address=client_ip,
    )
    return {"delivered_to": len(online_ids)}

