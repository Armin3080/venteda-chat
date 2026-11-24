from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from app.models.user import User, UserSettings
from app.models.conversation import Conversation, ConversationMember
from app.models.message import Message, MessageReaction
from app.core.config import settings
from app.security.passwords import get_password_hash
import logging

logger = logging.getLogger("venteda.seed")

def seed_database(db: Session):
    # Demo accounts are OFF by default. Enable only for local development in .env:
    #   SEED_DEMO_USERS=true
    #   DEMO_PASSWORD=<at least 12 characters>
    if not settings.SEED_DEMO_USERS:
        return
    demo_password = settings.DEMO_PASSWORD
    if len(demo_password) < 12:
        logger.warning("SEED_DEMO_USERS is enabled but DEMO_PASSWORD is missing or shorter than 12 characters; skipping demo seed.")
        return

    # If database is already seeded, skip
    if db.query(User).first():
        return

    password_hash = get_password_hash(demo_password)

    # Users
    owner = User(
        username="owner",
        display_name="Venteda Founder",
        email="owner@venteda.io",
        password_hash=password_hash,
        avatar_url="/static/images/venteda_logo_mark_1792875136518.jpg",
        bio="Platform Creator & System Architect · Full Owner Permissions",
        role="owner",
        connect_code="VNT-0001",
        privacy_mode="strict",
        is_online=True,
        last_seen=datetime.utcnow()
    )
    alice = User(
        username="alice",
        display_name="Alice Chen",
        email="alice@venteda.io",
        password_hash=password_hash,
        avatar_url="/static/images/avatar_designer_user_1792875137589.jpg",
        bio="Lead UI/UX Designer at Venteda · Passionate about typography and crisp dark UI",
        role="moderator",
        connect_code="VNT-7824",
        privacy_mode="strict",
        is_online=True,
        last_seen=datetime.utcnow()
    )
    bob = User(
        username="bob",
        display_name="Bob Miller",
        email="bob@venteda.io",
        password_hash=password_hash,
        avatar_url="/static/images/avatar_architect_user_1792875138410.jpg",
        bio="Distributed Systems Architect · Python, FastAPI, WebSockets & Security",
        role="support",
        connect_code="VNT-4190",
        privacy_mode="strict",
        is_online=True,
        last_seen=datetime.utcnow()
    )
    aria = User(
        username="aria",
        display_name="Aria Rad (آریا)",
        email="aria@venteda.io",
        password_hash=password_hash,
        avatar_url="/static/images/venteda_logo_mark_1792875136518.jpg",
        bio="Full-Stack Engineer & RTL Specialist · عاشق طراحی مینیمال و چت سریع",
        role="user",
        connect_code="VNT-5520",
        privacy_mode="strict",
        is_online=False,
        last_seen=datetime.utcnow() - timedelta(minutes=14)
    )
    support = User(
        username="venteda_bot",
        display_name="Venteda Assistant",
        email="support@venteda.io",
        password_hash=password_hash,
        avatar_url="/static/images/venteda_logo_mark_1792875136518.jpg",
        bio="Official Venteda automated updates & security alerts",
        role="user",
        connect_code="VNT-0000",
        privacy_mode="strict",
        is_online=True,
        last_seen=datetime.utcnow()
    )

    db.add_all([owner, alice, bob, aria, support])
    db.commit()

    for u in [owner, alice, bob, aria, support]:
        db.add(UserSettings(user_id=u.id, theme="dark", language="en" if u.username != "aria" else "fa"))
    db.commit()

    # 1. Direct Chat: Alice & Bob
    conv_alice_bob = Conversation(
        type="direct",
        created_by_id=bob.id,
        created_at=datetime.utcnow() - timedelta(hours=3),
        updated_at=datetime.utcnow() - timedelta(minutes=5)
    )
    db.add(conv_alice_bob)
    db.commit()

    mem_alice = ConversationMember(conversation_id=conv_alice_bob.id, user_id=alice.id, role="member")
    mem_bob = ConversationMember(conversation_id=conv_alice_bob.id, user_id=bob.id, role="member")
    db.add_all([mem_alice, mem_bob])
    db.commit()

    msg1 = Message(
        conversation_id=conv_alice_bob.id,
        sender_id=bob.id,
        text="Hey Alice! The new WebSocket engine for Venteda Chat is running with zero dropped frames. How does the dark navy palette look?",
        created_at=datetime.utcnow() - timedelta(hours=2, minutes=30)
    )
    db.add(msg1)
    db.commit()

    msg2 = Message(
        conversation_id=conv_alice_bob.id,
        sender_id=alice.id,
        text="It looks stunning! The icy-blue accents and Telegram-inspired workflow make it feel extraordinarily fast and clean.",
        reply_to_id=msg1.id,
        created_at=datetime.utcnow() - timedelta(hours=2, minutes=20)
    )
    db.add(msg2)
    db.commit()

    msg3 = Message(
        conversation_id=conv_alice_bob.id,
        sender_id=bob.id,
        text="Awesome. We also tested reconnect handling and duplicate-message prevention with client request IDs. Ready for production testing!",
        created_at=datetime.utcnow() - timedelta(minutes=5)
    )
    db.add(msg3)
    db.commit()

    # Add reaction
    db.add(MessageReaction(message_id=msg3.id, user_id=alice.id, emoji="🔥"))
    db.commit()

    # 2. Group Chat: Venteda Core Team
    conv_group = Conversation(
        type="group",
        title="Venteda Core Architecture",
        description="Engineering, design, and release synchronization for Venteda Chat",
        avatar_url="/static/images/avatar_team_group_1792875137734.jpg",
        created_by_id=bob.id,
        created_at=datetime.utcnow() - timedelta(days=2),
        updated_at=datetime.utcnow() - timedelta(minutes=2)
    )
    db.add(conv_group)
    db.commit()

    db.add_all([
        ConversationMember(conversation_id=conv_group.id, user_id=bob.id, role="owner"),
        ConversationMember(conversation_id=conv_group.id, user_id=alice.id, role="admin"),
        ConversationMember(conversation_id=conv_group.id, user_id=aria.id, role="member"),
        ConversationMember(conversation_id=conv_group.id, user_id=support.id, role="member"),
    ])
    db.commit()

    g_msg1 = Message(
        conversation_id=conv_group.id,
        sender_id=bob.id,
        text="Welcome team to Venteda Core Architecture channel. Let's ensure bilingual Persian (RTL) and English (LTR) layout works seamlessly.",
        is_pinned=True,
        created_at=datetime.utcnow() - timedelta(hours=18)
    )
    db.add(g_msg1)
    db.commit()
    conv_group.pinned_message_id = g_msg1.id
    db.commit()

    g_msg2 = Message(
        conversation_id=conv_group.id,
        sender_id=aria.id,
        text="سلام بچه‌ها! پشتیبانی از متن راست‌به‌چپ فارسی (RTL) و فونت مناسب با دقت کامل پیاده‌سازی شده. تست تبادل پیام دوزبانه عالی کار میکنه.",
        created_at=datetime.utcnow() - timedelta(hours=14)
    )
    db.add(g_msg2)
    db.commit()

    g_msg3 = Message(
        conversation_id=conv_group.id,
        sender_id=alice.id,
        text="Perfect Aria! Mixed bidirectional text rendering is super crisp. Pinned messages and search in chat work like a charm.",
        reply_to_id=g_msg2.id,
        created_at=datetime.utcnow() - timedelta(minutes=2)
    )
    db.add(g_msg3)
    db.commit()

    # 3. Direct Chat with Venteda Assistant
    conv_support = Conversation(
        type="direct",
        created_by_id=support.id,
        created_at=datetime.utcnow() - timedelta(days=1),
        updated_at=datetime.utcnow() - timedelta(hours=1)
    )
    db.add(conv_support)
    db.commit()

    db.add_all([
        ConversationMember(conversation_id=conv_support.id, user_id=support.id, role="member"),
        ConversationMember(conversation_id=conv_support.id, user_id=alice.id, role="member"),
        ConversationMember(conversation_id=conv_support.id, user_id=bob.id, role="member"),
    ])
    db.commit()

    s_msg = Message(
        conversation_id=conv_support.id,
        sender_id=support.id,
        text="🛡️ Venteda Security Notice: Your session is protected by Argon2/bcrypt token verification and rate limiting. Enjoy private, encrypted real-time communications.",
        created_at=datetime.utcnow() - timedelta(hours=1)
    )
    db.add(s_msg)
    db.commit()

    logger.info("Database seeding completed successfully.")
