import json
import logging
import uuid
from typing import Dict, Set, Any, Optional
from fastapi import WebSocket

logger = logging.getLogger("venteda.websocket")

class ConnectionManager:
    def __init__(self):
        # user_id -> set of active WebSockets (supports multi-tab / multi-device)
        self.active_users: Dict[str, Set[WebSocket]] = {}
        # websocket -> user_id
        self.ws_to_user: Dict[WebSocket, str] = {}
        # active_call_id -> call session metadata
        self.active_calls: Dict[str, Dict[str, Any]] = {}
        # user_id -> active_call_id
        self.user_to_call: Dict[str, str] = {}
        # group call id -> {conversation_id, call_type, participants}
        self.group_calls: Dict[str, Dict[str, Any]] = {}
        # user_id -> group call id
        self.user_to_group_call: Dict[str, str] = {}

    MAX_GROUP_CALL_PARTICIPANTS = 6

    async def connect(self, websocket: WebSocket, user_id: str):
        await websocket.accept()
        if user_id not in self.active_users:
            self.active_users[user_id] = set()
        self.active_users[user_id].add(websocket)
        self.ws_to_user[websocket] = user_id
        logger.info(f"WebSocket connected for user {user_id}. Active sessions: {len(self.active_users[user_id])}")

    def disconnect(self, websocket: WebSocket) -> Optional[str]:
        user_id = self.ws_to_user.pop(websocket, None)
        if user_id and user_id in self.active_users:
            self.active_users[user_id].discard(websocket)
            if not self.active_users[user_id]:
                del self.active_users[user_id]
        logger.info(f"WebSocket disconnected for user {user_id}")
        return user_id

    async def disconnect_user(self, user_id: str):
        """Immediately closes and severs all active sockets for a banned or revoked user."""
        if user_id in self.active_users:
            sockets = list(self.active_users[user_id])
            for ws in sockets:
                try:
                    await ws.close(code=1008)
                except Exception:
                    pass
                self.disconnect(ws)
            logger.info(f"Terminated all sockets for user {user_id}")

    def is_user_online(self, user_id: str) -> bool:
        return user_id in self.active_users and len(self.active_users[user_id]) > 0

    def is_user_busy(self, user_id: str) -> bool:
        return user_id in self.user_to_call or user_id in self.user_to_group_call

    def register_group_call(self, conversation_id: str, call_type: str, starter_id: str) -> str:
        call_id = f"gcall_{uuid.uuid4().hex[:12]}"
        self.group_calls[call_id] = {
            "conversation_id": conversation_id,
            "call_type": call_type,
            "participants": set(),
        }
        self.join_group_call(call_id, starter_id)
        return call_id

    def join_group_call(self, call_id: str, user_id: str) -> None:
        self.group_calls[call_id]["participants"].add(user_id)
        self.user_to_group_call[user_id] = call_id

    def leave_group_call(self, user_id: str):
        """Returns (call_id, remaining_participants) or None if the user was not in a group call."""
        call_id = self.user_to_group_call.pop(user_id, None)
        call = self.group_calls.get(call_id) if call_id else None
        if not call:
            return None
        call["participants"].discard(user_id)
        remaining = set(call["participants"])
        if not remaining:
            self.group_calls.pop(call_id, None)
        return call_id, remaining

    def register_call(self, call_id: str, caller_id: str, receiver_id: str, call_type: str, conversation_id: Optional[str]):
        self.active_calls[call_id] = {
            "call_id": call_id,
            "caller_id": caller_id,
            "receiver_id": receiver_id,
            "call_type": call_type,
            "conversation_id": conversation_id,
            "status": "ringing"
        }
        self.user_to_call[caller_id] = call_id
        self.user_to_call[receiver_id] = call_id

    def end_call(self, call_id: str) -> Optional[Dict[str, Any]]:
        call = self.active_calls.pop(call_id, None)
        if call:
            self.user_to_call.pop(call["caller_id"], None)
            self.user_to_call.pop(call["receiver_id"], None)
        return call

    def get_call_by_user(self, user_id: str) -> Optional[Dict[str, Any]]:
        call_id = self.user_to_call.get(user_id)
        if call_id:
            return self.active_calls.get(call_id)
        return None

    async def send_personal_message(self, message: Dict[str, Any], user_id: str):
        if user_id in self.active_users:
            dead_sockets = set()
            payload = json.dumps(message, default=str)
            for ws in self.active_users[user_id]:
                try:
                    await ws.send_text(payload)
                except Exception as e:
                    logger.warning(f"Error sending to user {user_id}: {e}")
                    dead_sockets.add(ws)
            for ws in dead_sockets:
                self.disconnect(ws)

    async def broadcast_to_users(self, message: Dict[str, Any], user_ids: Set[str]):
        """
        Broadcasts safely to a set of user IDs (members of a conversation).
        """
        payload = json.dumps(message, default=str)
        for user_id in user_ids:
            if user_id in self.active_users:
                dead_sockets = set()
                for ws in self.active_users[user_id]:
                    try:
                        await ws.send_text(payload)
                    except Exception as e:
                        logger.warning(f"Broadcast error to user {user_id}: {e}")
                        dead_sockets.add(ws)
                for ws in dead_sockets:
                    self.disconnect(ws)

manager = ConnectionManager()
