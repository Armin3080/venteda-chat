import json
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, status, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, JSONResponse
import os
import uuid
from datetime import datetime

from app.core.config import settings
from app.core.database import Base, engine, SessionLocal
from app.services.seed import seed_database
from app.security.connect_code import backfill_connect_codes
from app.api import contacts, stories, saved_media, media, admin_extra
from app.services.story_service import ensure_story_schema, ensure_user_schema
from app.services.contact_service import is_blocked_between
from app.api import auth, users, conversations, messages, attachments, health, admin, reports, calls
from app.websocket.manager import manager
from app.security.tokens import decode_access_token
from app.models.user import User, UserSession
from app.models.conversation import Conversation, ConversationMember
from app.models.call import CallRecord
from app.services.chat_service import create_message, format_message
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Logging setup
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("venteda.main")

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing Venteda database schemas...")
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        ensure_story_schema()
        ensure_user_schema()
        # No socket survives a restart, so nobody is online yet
        db.query(User).filter(User.is_online.is_(True)).update({User.is_online: False}, synchronize_session=False)
        db.commit()
        seed_database(db)
        backfill_connect_codes(db)
    finally:
        db.close()
    logger.info("Venteda Chat backend ready.")
    yield
    logger.info("Shutting down Venteda Chat backend...")

app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc"
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept"],
)

# Include API Routers
app.include_router(auth.router)
app.include_router(users.router)
app.include_router(conversations.router)
app.include_router(messages.router)
app.include_router(attachments.router)
app.include_router(calls.router)
app.include_router(admin.router)
app.include_router(reports.router)
app.include_router(contacts.router)
app.include_router(stories.router)
app.include_router(saved_media.router)
app.include_router(media.router)
app.include_router(admin_extra.router)
app.include_router(health.router)

# Mount Static & Uploads Directories
os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
os.makedirs("static", exist_ok=True)
os.makedirs("templates", exist_ok=True)

app.add_middleware(GZipMiddleware, minimum_size=1000)

@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    # unsafe-inline is required by the current inline event handlers; removing it needs a UI refactor
    response.headers.setdefault("Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; "
        "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; "
        "object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(self), microphone=(self)")
    # Always revalidate the app shell and static files so browsers never run stale JavaScript
    path = request.url.path
    if path == "/" or path.startswith(("/admin", "/static/")):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response

app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")

templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))

# Client Configuration Route
@app.get("/api/config")
def get_client_config():
    return {
        "app_name": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "stun_server": settings.STUN_SERVER,
        "turn_server": settings.TURN_SERVER,
        "max_upload_bytes": settings.MAX_UPLOAD_SIZE_BYTES,
        "max_voice_bytes": settings.MAX_VOICE_SIZE_BYTES,
    }

# Frontend Page Routes (Served by Python FastAPI & Jinja2)
@app.get("/", response_class=HTMLResponse)
def index_page(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "app_name": settings.APP_NAME,
            "version": settings.APP_VERSION,
            "stun_server": settings.STUN_SERVER,
        }
    )

@app.get("/admin", response_class=HTMLResponse)
def admin_page(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="admin.html",
        context={
            "app_name": settings.APP_NAME,
            "version": settings.APP_VERSION,
        }
    )

# Authenticated WebSocket with Real-Time Messaging & WebRTC Call Signaling
async def notify_presence(db, user_id: str, is_online: bool, last_seen) -> None:
    """Tell only the users who share a conversation with this user (no global presence leak)."""
    conv_ids = [r.conversation_id for r in db.query(ConversationMember.conversation_id)
                .filter(ConversationMember.user_id == user_id).all()]
    if not conv_ids:
        return
    peer_ids = {r.user_id for r in db.query(ConversationMember.user_id)
                .filter(ConversationMember.conversation_id.in_(conv_ids),
                        ConversationMember.user_id != user_id).distinct().all()}
    await manager.broadcast_to_users(
        {"event": "presence", "data": {
            "user_id": user_id,
            "is_online": is_online,
            "last_seen": last_seen.isoformat() if last_seen else None,
        }},
        peer_ids,
    )

def is_member(db, conversation_id: str, user_id: str) -> bool:
    return db.query(ConversationMember.id).filter(
        ConversationMember.conversation_id == conversation_id,
        ConversationMember.user_id == user_id,
    ).first() is not None


async def leave_group_call_and_notify(user_id: str) -> None:
    result = manager.leave_group_call(user_id)
    if not result:
        return
    call_id, remaining = result
    if remaining:
        await manager.broadcast_to_users(
            {"event": "group_call_peer_left", "data": {"group_call_id": call_id, "user_id": user_id}},
            remaining,
        )


@app.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    token: str = Query(...)
):
    payload = decode_access_token(token)
    if not payload:
        logger.warning("Rejected unauthenticated WebSocket connection attempt.")
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    user_id = payload.get("sub")
    jti = payload.get("jti")
    if not user_id:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    db = SessionLocal()
    user = db.query(User).filter(User.id == user_id).first()
    session_rec = None
    if jti:
        session_rec = db.query(UserSession).filter(
            UserSession.token_jti == jti, UserSession.user_id == user_id
        ).first()
    if (
        not user
        or user.is_banned
        or user.is_active is False
        or (jti and (session_rec is None or session_rec.is_revoked))
    ):
        logger.warning("Rejected invalid, revoked, banned, or inactive WebSocket session.")
        db.close()
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    if session_rec:
        session_rec.last_active_at = datetime.utcnow()
    user.is_online = True
    db.commit()

    await manager.connect(websocket, user_id)

    # First socket for this user means they just came online
    if len(manager.active_users.get(user_id, ())) == 1:
        await notify_presence(db, user_id, True, None)

    try:
        while True:
            raw_data = await websocket.receive_text()
            try:
                msg_json = json.loads(raw_data)
            except json.JSONDecodeError:
                await websocket.send_text(json.dumps({"event": "error", "message": "Invalid JSON format."}))
                continue

            action = msg_json.get("action")
            data = msg_json.get("data", {})
            conversation_id = msg_json.get("conversation_id") or data.get("conversation_id")

            if action == "ping":
                await websocket.send_text(json.dumps({"event": "pong"}))

            # -------------------------------------------------------------
            # Messaging & Chat Actions
            # -------------------------------------------------------------
            elif action == "typing" and conversation_id:
                is_typing = data.get("is_typing", True)
                conv = db.query(Conversation).filter(Conversation.id == conversation_id).first()
                if conv:
                    other_member_ids = {m.user_id for m in conv.members if m.user_id != user_id}
                    await manager.broadcast_to_users(
                        {
                            "event": "user_typing",
                            "data": {
                                "conversation_id": conversation_id,
                                "user_id": user_id,
                                "display_name": user.display_name,
                                "is_typing": is_typing
                            }
                        },
                        other_member_ids
                    )

            elif action == "send_message" and conversation_id:
                text = data.get("text", "").strip()
                client_msg_id = data.get("client_msg_id")
                reply_to_id = data.get("reply_to_id")
                forwarded_from_id = data.get("forwarded_from_id")
                forwarded_from_title = data.get("forwarded_from_title")
                if text:
                    msg = create_message(
                        conversation_id=conversation_id,
                        sender_id=user_id,
                        text=text,
                        client_msg_id=client_msg_id,
                        reply_to_id=reply_to_id,
                        forwarded_from_id=forwarded_from_id,
                        forwarded_from_title=forwarded_from_title,
                        db=db
                    )
                    formatted = format_message(msg, user_id, db)
                    await websocket.send_text(json.dumps({
                        "event": "message_ack",
                        "data": {"client_msg_id": client_msg_id, "message_id": msg.id}
                    }))
                    conv = db.query(Conversation).filter(Conversation.id == conversation_id).first()
                    if conv:
                        member_ids = {m.user_id for m in conv.members}
                        await manager.broadcast_to_users(
                            {
                                "event": "new_message",
                                "data": formatted.model_dump(mode="json")
                            },
                            member_ids
                        )

            elif action == "read_receipt" and conversation_id:
                last_read_message_id = data.get("last_read_message_id")
                if last_read_message_id:
                    conv = db.query(Conversation).filter(Conversation.id == conversation_id).first()
                    if conv:
                        member_ids = {m.user_id for m in conv.members}
                        await manager.broadcast_to_users(
                            {
                                "event": "message_read",
                                "data": {
                                    "conversation_id": conversation_id,
                                    "user_id": user_id,
                                    "last_read_message_id": last_read_message_id
                                }
                            },
                            member_ids
                        )

            elif action == "broadcast_announcement":
                # Only owner or moderator can broadcast
                if user.role in ["owner", "moderator"]:
                    ann_text = data.get("text", "").strip()
                    if ann_text:
                        all_online_users = set(manager.active_users.keys())
                        await manager.broadcast_to_users(
                            {
                                "event": "system_announcement",
                                "data": {
                                    "text": ann_text,
                                    "sender": user.display_name,
                                    "created_at": datetime.utcnow().isoformat()
                                }
                            },
                            all_online_users
                        )

            # -------------------------------------------------------------
            # WebRTC Audio & Video Call Signaling Actions
            # -------------------------------------------------------------
            # -------------------------------------------------------------
            # Group calls: full mesh, each participant connects to every other
            # -------------------------------------------------------------
            elif action == "group_call_start":
                conv_id = data.get("conversation_id")
                call_type = data.get("call_type", "audio")
                if call_type not in ("audio", "video"):
                    call_type = "audio"
                conv_obj = db.query(Conversation).filter(Conversation.id == conv_id).first()
                if not conv_obj or conv_obj.type != "group" or not is_member(db, conv_id, user_id):
                    await websocket.send_text(json.dumps({"event": "call_error", "data": {"message": "Group calls are only available in groups you belong to."}}))
                    continue
                if manager.is_user_busy(user_id):
                    await websocket.send_text(json.dumps({"event": "call_error", "data": {"message": "You are already in a call."}}))
                    continue
                gc_id = manager.register_group_call(conv_id, call_type, user_id)
                await websocket.send_text(json.dumps({"event": "group_call_started", "data": {"group_call_id": gc_id, "conversation_id": conv_id, "call_type": call_type}}))
                invite_targets = {m.user_id for m in conv_obj.members} - {user_id}
                await manager.broadcast_to_users(
                    {"event": "group_call_invite", "data": {
                        "group_call_id": gc_id,
                        "conversation_id": conv_id,
                        "call_type": call_type,
                        "starter_id": user_id,
                        "starter_name": user.display_name,
                        "title": conv_obj.title,
                    }},
                    invite_targets,
                )

            elif action == "group_call_join":
                gc_id = data.get("group_call_id")
                call = manager.group_calls.get(gc_id)
                if not call or not is_member(db, call["conversation_id"], user_id):
                    await websocket.send_text(json.dumps({"event": "call_error", "data": {"message": "This group call has ended."}}))
                    continue
                if user_id in call["participants"]:
                    continue
                if manager.is_user_busy(user_id):
                    await websocket.send_text(json.dumps({"event": "call_error", "data": {"message": "You are already in a call."}}))
                    continue
                if len(call["participants"]) >= manager.MAX_GROUP_CALL_PARTICIPANTS:
                    await websocket.send_text(json.dumps({"event": "call_error", "data": {"message": f"This group call is full ({manager.MAX_GROUP_CALL_PARTICIPANTS} participants)."}}))
                    continue
                existing = sorted(call["participants"])
                manager.join_group_call(gc_id, user_id)
                names = {u.id: u.display_name for u in db.query(User).filter(User.id.in_(existing)).all()}
                await websocket.send_text(json.dumps({"event": "group_call_joined", "data": {
                    "group_call_id": gc_id,
                    "call_type": call["call_type"],
                    "peers": [{"user_id": pid, "display_name": names.get(pid, "Member")} for pid in existing],
                }}))
                await manager.broadcast_to_users(
                    {"event": "group_call_peer_joined", "data": {"group_call_id": gc_id, "user_id": user_id, "display_name": user.display_name}},
                    set(existing),
                )

            elif action == "group_call_signal":
                gc_id = data.get("group_call_id")
                to_id = data.get("to_user_id")
                kind = data.get("kind")
                call = manager.group_calls.get(gc_id)
                if (call and kind in ("offer", "answer", "ice") and to_id != user_id
                        and user_id in call["participants"] and to_id in call["participants"]):
                    await manager.send_personal_message(
                        {"event": "group_call_signal", "data": {
                            "group_call_id": gc_id,
                            "from_user_id": user_id,
                            "kind": kind,
                            "payload": data.get("payload"),
                        }},
                        to_id,
                    )

            elif action == "group_call_leave":
                await leave_group_call_and_notify(user_id)

            elif action == "call_invite":
                target_user_id = data.get("target_user_id")
                call_type = data.get("call_type", "audio")  # "audio" or "video"
                conv_id = data.get("conversation_id")
                
                if not target_user_id or target_user_id == user_id:
                    await websocket.send_text(json.dumps({"event": "call_error", "data": {"message": "Invalid recipient."}}))
                    continue

                if is_blocked_between(db, user_id, target_user_id):
                    await websocket.send_text(json.dumps({"event": "call_error", "data": {"message": "You cannot call this user."}}))
                    continue

                if not manager.is_user_online(target_user_id):
                    await websocket.send_text(json.dumps({"event": "call_user_offline", "data": {"target_user_id": target_user_id}}))
                    # Record missed call
                    missed_rec = CallRecord(
                        caller_id=user_id,
                        receiver_id=target_user_id,
                        conversation_id=conv_id,
                        call_type=call_type,
                        status="missed",
                        duration_seconds=0
                    )
                    db.add(missed_rec)
                    db.commit()
                    continue

                if manager.is_user_busy(target_user_id):
                    await websocket.send_text(json.dumps({"event": "call_busy", "data": {"target_user_id": target_user_id}}))
                    busy_rec = CallRecord(
                        caller_id=user_id,
                        receiver_id=target_user_id,
                        conversation_id=conv_id,
                        call_type=call_type,
                        status="busy",
                        duration_seconds=0
                    )
                    db.add(busy_rec)
                    db.commit()
                    continue

                call_id = f"call_{uuid.uuid4().hex[:12]}"
                manager.register_call(call_id, user_id, target_user_id, call_type, conv_id)

                # Create active call record
                record = CallRecord(
                    id=call_id,
                    caller_id=user_id,
                    receiver_id=target_user_id,
                    conversation_id=conv_id,
                    call_type=call_type,
                    status="ringing",
                    duration_seconds=0,
                    created_at=datetime.utcnow()
                )
                db.add(record)
                db.commit()

                # Notify target of incoming call
                await manager.send_personal_message(
                    {
                        "event": "incoming_call",
                        "data": {
                            "call_id": call_id,
                            "caller_id": user_id,
                            "caller_name": user.display_name,
                            "caller_username": user.username,
                            "caller_avatar": user.avatar_url,
                            "call_type": call_type,
                            "conversation_id": conv_id
                        }
                    },
                    target_user_id
                )

                # Acknowledge caller that invite was dispatched
                await websocket.send_text(json.dumps({
                    "event": "call_initiated",
                    "data": {
                        "call_id": call_id,
                        "target_user_id": target_user_id,
                        "call_type": call_type,
                        "conversation_id": conv_id
                    }
                }))

            elif action == "call_ringing":
                call_id = data.get("call_id")
                active = manager.active_calls.get(call_id)
                if active:
                    await manager.send_personal_message(
                        {"event": "call_ringing", "data": {"call_id": call_id}},
                        active["caller_id"]
                    )

            elif action == "call_accept":
                call_id = data.get("call_id")
                active = manager.active_calls.get(call_id)
                if active:
                    active["status"] = "in_progress"
                    rec = db.query(CallRecord).filter(CallRecord.id == call_id).first()
                    if rec:
                        rec.status = "in_progress"
                        db.commit()

                    await manager.send_personal_message(
                        {"event": "call_accepted", "data": {"call_id": call_id}},
                        active["caller_id"]
                    )

            elif action == "call_reject":
                call_id = data.get("call_id")
                ended = manager.end_call(call_id)
                if ended:
                    rec = db.query(CallRecord).filter(CallRecord.id == call_id).first()
                    if rec:
                        rec.status = "rejected"
                        rec.ended_at = datetime.utcnow()
                        db.commit()
                    await manager.send_personal_message(
                        {"event": "call_rejected", "data": {"call_id": call_id}},
                        ended["caller_id"]
                    )

            elif action == "call_cancel":
                call_id = data.get("call_id")
                ended = manager.end_call(call_id)
                if ended:
                    rec = db.query(CallRecord).filter(CallRecord.id == call_id).first()
                    if rec:
                        rec.status = "cancelled"
                        rec.ended_at = datetime.utcnow()
                        db.commit()
                    await manager.send_personal_message(
                        {"event": "call_cancelled", "data": {"call_id": call_id}},
                        ended["receiver_id"]
                    )

            elif action == "call_offer":
                call_id = data.get("call_id")
                offer = data.get("offer")
                active = manager.active_calls.get(call_id)
                if active:
                    target_id = active["receiver_id"] if user_id == active["caller_id"] else active["caller_id"]
                    await manager.send_personal_message(
                        {"event": "call_offer", "data": {"call_id": call_id, "offer": offer, "sender_id": user_id}},
                        target_id
                    )

            elif action == "call_answer":
                call_id = data.get("call_id")
                answer = data.get("answer")
                active = manager.active_calls.get(call_id)
                if active:
                    target_id = active["caller_id"] if user_id == active["receiver_id"] else active["receiver_id"]
                    await manager.send_personal_message(
                        {"event": "call_answer", "data": {"call_id": call_id, "answer": answer, "sender_id": user_id}},
                        target_id
                    )

            elif action == "ice_candidate":
                call_id = data.get("call_id")
                candidate = data.get("candidate")
                active = manager.active_calls.get(call_id)
                if active:
                    target_id = active["receiver_id"] if user_id == active["caller_id"] else active["caller_id"]
                    await manager.send_personal_message(
                        {"event": "ice_candidate", "data": {"call_id": call_id, "candidate": candidate, "sender_id": user_id}},
                        target_id
                    )

            elif action == "call_hangup":
                call_id = data.get("call_id")
                ended = manager.end_call(call_id)
                if ended:
                    rec = db.query(CallRecord).filter(CallRecord.id == call_id).first()
                    dur = 0
                    if rec:
                        now = datetime.utcnow()
                        dur = max(1, int((now - rec.created_at).total_seconds())) if rec.status == "in_progress" else 0
                        rec.status = "completed" if rec.status == "in_progress" else rec.status
                        rec.duration_seconds = dur
                        rec.ended_at = now
                        db.commit()

                    target_id = ended["receiver_id"] if user_id == ended["caller_id"] else ended["caller_id"]
                    await manager.send_personal_message(
                        {"event": "call_ended", "data": {"call_id": call_id, "duration_seconds": dur}},
                        target_id
                    )

    except WebSocketDisconnect:
        # Check if user had an active call and terminate it
        active_call = manager.get_call_by_user(user_id)
        if active_call:
            call_id = active_call["call_id"]
            ended = manager.end_call(call_id)
            if ended:
                target_id = ended["receiver_id"] if user_id == ended["caller_id"] else ended["caller_id"]
                await manager.send_personal_message(
                    {"event": "call_ended", "data": {"call_id": call_id, "reason": "connection_lost"}},
                    target_id
                )
        manager.disconnect(websocket)
        if not manager.is_user_online(user_id):
            user.is_online = False
            user.last_seen = datetime.utcnow()
            db.commit()
            await notify_presence(db, user_id, False, user.last_seen)
    except Exception as e:
        logger.error(f"WebSocket error for user {user_id}: {e}")
        manager.disconnect(websocket)
        if not manager.is_user_online(user_id):
            user.is_online = False
            user.last_seen = datetime.utcnow()
            db.commit()
            await notify_presence(db, user_id, False, user.last_seen)
    finally:
        # Only leave the group call when this was the user's last open socket
        if not manager.is_user_online(user_id):
            await leave_group_call_and_notify(user_id)
        db.close()

# Root API info
@app.get("/api")
def root_info():
    return {
        "app": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "status": "operational",
        "docs": "/api/docs"
    }
