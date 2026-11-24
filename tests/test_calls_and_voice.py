import io
import uuid
import pytest
from app.models.call import CallRecord

def create_user(client, prefix="call_user"):
    unique = uuid.uuid4().hex[:8]
    username = f"{prefix}_{unique}"
    password = "SecurePassword123!"
    res = client.post("/api/auth/register", json={
        "username": username,
        "display_name": f"Call User {unique}",
        "password": password
    })
    data = res.json()
    return data["user"], data["access_token"]

def test_voice_message_upload_and_validation(client):
    u1, token1 = create_user(client, "alice_voice")
    u2, token2 = create_user(client, "bob_voice")
    outsider, outsider_token = create_user(client, "outsider_voice")

    h1 = {"Authorization": f"Bearer {token1}"}
    h2 = {"Authorization": f"Bearer {token2}"}
    h_out = {"Authorization": f"Bearer {outsider_token}"}

    # Alice creates conversation with Bob
    conv = client.post("/api/conversations", json={
        "type": "direct",
        "recipient_id": u2["id"]
    }, headers=h1).json()
    conv_id = conv["id"]

    # 1. Alice uploads an authentic audio recording
    fake_audio_bytes = b"RIFF....WAVEfmt ....data..."
    voice_res = client.post(
        f"/api/conversations/{conv_id}/voice",
        files={"audio": ("voice_note.webm", io.BytesIO(fake_audio_bytes), "audio/webm")},
        data={"duration": "14"},
        headers=h1
    )
    assert voice_res.status_code == 201
    msg = voice_res.json()
    assert "Voice Message" in msg["text"]
    assert len(msg["attachments"]) == 1
    att = msg["attachments"][0]
    assert att["duration_seconds"] == 14
    assert "audio" in att["mime_type"]

    # 2. Bob (member) can download the audio
    att_id = att["id"]
    dl_res = client.get(f"/api/attachments/{att_id}/download", headers=h2)
    assert dl_res.status_code == 200
    assert dl_res.content == fake_audio_bytes

    # 3. Outsider is forbidden
    unauth_dl = client.get(f"/api/attachments/{att_id}/download", headers=h_out)
    assert unauth_dl.status_code == 403

def test_webrtc_config_and_call_history(client, db_session):
    u1, token1 = create_user(client, "caller")
    u2, token2 = create_user(client, "callee")

    h1 = {"Authorization": f"Bearer {token1}"}

    # 1. Fetch WebRTC ICE config
    config_res = client.get("/api/calls/config", headers=h1)
    assert config_res.status_code == 200
    cfg = config_res.json()
    assert "ice_servers" in cfg
    assert len(cfg["ice_servers"]) >= 1

    # 2. Insert test call record and fetch history
    call_rec = CallRecord(
        caller_id=u1["id"],
        receiver_id=u2["id"],
        call_type="video",
        status="completed",
        duration_seconds=42
    )
    db_session.add(call_rec)
    db_session.commit()

    hist_res = client.get("/api/calls/history", headers=h1)
    assert hist_res.status_code == 200
    history = hist_res.json()
    assert any(c["id"] == call_rec.id for c in history)
    assert any(c["duration_seconds"] == 42 for c in history)
