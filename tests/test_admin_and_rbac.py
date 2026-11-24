import pytest
from datetime import datetime
from fastapi.testclient import TestClient
from app.main import app
from app.core.database import SessionLocal, Base, engine
from app.models.user import User, UserSettings
from app.models.conversation import Conversation, ConversationMember
from app.models.message import Message
from app.models.admin import AuditLog, ModerationReport
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

def test_rbac_admin_endpoints_require_staff(client, db_session):
    # Regular user
    reg_user = User(
        username="test_regular_user",
        display_name="Regular User",
        password_hash=get_password_hash("pass1234"),
        role="user",
        connect_code="VNT-9901"
    )
    db_session.add(reg_user)
    db_session.commit()

    token = create_access_token({"sub": reg_user.id, "username": reg_user.username})
    headers = {"Authorization": f"Bearer {token}"}

    # Should be rejected with 403 Forbidden
    res = client.get("/api/admin/metrics", headers=headers)
    assert res.status_code == 403
    assert "Access denied" in res.json()["detail"]

def test_owner_access_and_ban_unban_flow(client, db_session):
    # Create owner
    owner = User(
        username="super_owner",
        display_name="Platform Owner",
        password_hash=get_password_hash("ownerpass123"),
        role="owner",
        connect_code="VNT-0001"
    )
    target = User(
        username="spammer_target",
        display_name="Spammer Bob",
        password_hash=get_password_hash("spammerpass123"),
        role="user",
        connect_code="VNT-9902"
    )
    db_session.add_all([owner, target])
    db_session.commit()

    owner_token = create_access_token({"sub": owner.id, "username": owner.username})
    target_token = create_access_token({"sub": target.id, "username": target.username})

    # Owner can get metrics
    res = client.get("/api/admin/metrics", headers={"Authorization": f"Bearer {owner_token}"})
    assert res.status_code == 200
    metrics = res.json()
    assert "total_users" in metrics

    # Owner bans target user
    ban_res = client.post(
        f"/api/admin/users/{target.id}/ban",
        json={"reason": "Spamming offensive promotional content in groups", "duration_hours": 24},
        headers={"Authorization": f"Bearer {owner_token}"}
    )
    assert ban_res.status_code == 200

    # Target user is now banned and cannot access /api/auth/me
    blocked_res = client.get("/api/auth/me", headers={"Authorization": f"Bearer {target_token}"})
    assert blocked_res.status_code == 403
    assert "suspended" in blocked_res.json()["detail"]

    # Verify audit log was created
    audit = db_session.query(AuditLog).filter(
        AuditLog.action == "USER_BAN",
        AuditLog.target_id == target.id
    ).first()
    assert audit is not None
    assert "Spamming" in audit.reason

    # Owner unbans target user
    unban_res = client.post(
        f"/api/admin/users/{target.id}/unban",
        json={"reason": "Appeal accepted"},
        headers={"Authorization": f"Bearer {owner_token}"}
    )
    assert unban_res.status_code == 200

    # Target user can now access /api/auth/me again
    re_allowed = client.get("/api/auth/me", headers={"Authorization": f"Bearer {target_token}"})
    assert re_allowed.status_code == 200

def test_mandatory_reason_for_content_audit(client, db_session):
    owner = User(
        username="audit_owner",
        display_name="Auditor",
        password_hash=get_password_hash("auditorpass1"),
        role="owner",
        connect_code="VNT-0002"
    )
    db_session.add(owner)
    db_session.commit()

    conv = Conversation(type="group", title="Secret Channel")
    db_session.add(conv)
    db_session.commit()

    owner_token = create_access_token({"sub": owner.id, "username": owner.username})

    # Missing reason or reason too short -> 422 or 400
    res_invalid = client.post(
        f"/api/admin/conversations/{conv.id}/audit-inspect",
        json={"reason": "no"},
        headers={"Authorization": f"Bearer {owner_token}"}
    )
    assert res_invalid.status_code in [400, 422]

    # Valid mandatory justification reason
    res_valid = client.post(
        f"/api/admin/conversations/{conv.id}/audit-inspect",
        json={"reason": "Investigating high-priority report regarding potential policy breach"},
        headers={"Authorization": f"Bearer {owner_token}"}
    )
    assert res_valid.status_code == 200
    assert "messages" in res_valid.json()

    # Check audit trail entry
    log_entry = db_session.query(AuditLog).filter(
        AuditLog.action == "CONTENT_INSPECT",
        AuditLog.target_id == conv.id
    ).first()
    assert log_entry is not None
    assert log_entry.actor_username == "audit_owner"
