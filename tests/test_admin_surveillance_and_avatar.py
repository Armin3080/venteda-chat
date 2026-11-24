import pytest
import io
from fastapi.testclient import TestClient
from app.main import app
from app.core.database import SessionLocal, Base, engine
from app.models.user import User
from app.models.conversation import Conversation, ConversationMember
from app.models.message import Message
from app.security.passwords import get_password_hash
from app.security.tokens import create_access_token

@pytest.fixture
def db_session():
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()

@pytest.fixture
def client():
    return TestClient(app)

def test_avatar_upload_and_delete(client, db_session):
    user = User(
        username="avatar_test_user",
        display_name="Avatar Tester",
        password_hash=get_password_hash("pass123"),
        role="user",
        connect_code="VNT-8811"
    )
    db_session.add(user)
    db_session.commit()

    token = create_access_token({"sub": user.id, "username": user.username})
    headers = {"Authorization": f"Bearer {token}"}

    # 1. Upload valid image
    fake_img = io.BytesIO(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4")
    res = client.post(
        "/api/users/me/avatar",
        headers=headers,
        files={"file": ("profile.png", fake_img, "image/png")}
    )
    assert res.status_code == 200
    data = res.json()
    assert data["avatar_url"] is not None
    assert "/media/avatars/" in data["avatar_url"]

    # 2. Verify avatar persisted in DB
    db_session.expire_all()
    refreshed = db_session.query(User).filter(User.id == user.id).first()
    assert refreshed.avatar_url == data["avatar_url"]

    # 3. Delete avatar
    del_res = client.delete("/api/users/me/avatar", headers=headers)
    assert del_res.status_code == 200
    assert del_res.json()["avatar_url"] is None

def test_admin_user_dossier_and_surveillance(client, db_session):
    owner = User(
        username="admin_surv_owner",
        display_name="Surveillance Owner",
        password_hash=get_password_hash("owner123"),
        role="owner",
        connect_code="VNT-0077"
    )
    target = User(
        username="inspected_user",
        display_name="Inspected User",
        password_hash=get_password_hash("target123"),
        role="user",
        connect_code="VNT-9988"
    )
    db_session.add_all([owner, target])
    db_session.commit()

    # Create conversation and messages
    conv = Conversation(type="direct", title="Test Chat")
    db_session.add(conv)
    db_session.commit()

    mem1 = ConversationMember(conversation_id=conv.id, user_id=target.id, role="member")
    mem2 = ConversationMember(conversation_id=conv.id, user_id=owner.id, role="member")
    db_session.add_all([mem1, mem2])
    db_session.commit()

    msg = Message(conversation_id=conv.id, sender_id=target.id, text="Secret chat message for surveillance test")
    db_session.add(msg)
    db_session.commit()

    owner_token = create_access_token({"sub": owner.id, "username": owner.username})
    headers = {"Authorization": f"Bearer {owner_token}"}

    # 1. Fetch user dossier
    dossier_res = client.get(f"/api/admin/users/{target.id}/dossier", headers=headers)
    assert dossier_res.status_code == 200
    dossier = dossier_res.json()
    assert dossier["user"]["username"] == "inspected_user"
    assert dossier["stats"]["total_sent_messages"] >= 1
    assert len(dossier["conversations"]) >= 1

    # 2. Fetch conversation messages as admin
    conv_res = client.get(f"/api/admin/conversations/{conv.id}/messages", headers=headers)
    assert conv_res.status_code == 200
    conv_data = conv_res.json()
    assert len(conv_data["messages"]) >= 1
    assert conv_data["messages"][0]["text"] == "Secret chat message for surveillance test"

    # 3. Global live feed
    feed_res = client.get("/api/admin/live-feed", headers=headers)
    assert feed_res.status_code == 200
    assert len(feed_res.json()) >= 1
