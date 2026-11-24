"""Helpers for relationships between two users."""
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.conversation import ConversationMember
from app.models.contact import UserContact


def shares_conversation(db: Session, a: str, b: str) -> bool:
    """True when both users are members of at least one common conversation."""
    a_ids = [r[0] for r in db.query(ConversationMember.conversation_id)
             .filter(ConversationMember.user_id == a).all()]
    if not a_ids:
        return False
    return db.query(ConversationMember.id).filter(
        ConversationMember.user_id == b,
        ConversationMember.conversation_id.in_(a_ids),
    ).first() is not None


def is_blocked_between(db: Session, a: str, b: str) -> bool:
    """True when either user has blocked the other. Blocking stops messages and calls both ways."""
    return db.query(UserContact.id).filter(
        UserContact.is_blocked.is_(True),
        or_(
            (UserContact.owner_id == a) & (UserContact.target_id == b),
            (UserContact.owner_id == b) & (UserContact.target_id == a),
        ),
    ).first() is not None
