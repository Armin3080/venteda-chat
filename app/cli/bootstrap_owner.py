#!/usr/bin/env python3
"""
VENTEDA CHAT: Owner account bootstrap CLI.

Creates the platform owner, or promotes an existing account to owner.
The owner account cannot be created through public registration.

Usage (from the project folder):
    python main.py --bootstrap-owner --username admin_owner --password "<strong password>" --email owner@example.com
"""

import argparse
import logging
import sys
from datetime import datetime

from app.core.database import Base, SessionLocal, engine
from app.models.admin import AuditLog
from app.models.user import User, UserSettings
from app.security.connect_code import unique_connect_code
from app.security.passwords import get_password_hash

MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_BYTES = 72  # bcrypt ignores everything after 72 bytes

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("venteda.bootstrap")


def _validate_password(password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Owner password must be at least {MIN_PASSWORD_LENGTH} characters long.")
    if len(password.encode("utf-8")) > MAX_PASSWORD_BYTES:
        raise ValueError(f"Owner password must be at most {MAX_PASSWORD_BYTES} bytes long.")


def _new_connect_code(db) -> str:
    return unique_connect_code(db)


def bootstrap_owner(username: str, password: str, email: str = None, display_name: str = None) -> User:
    _validate_password(password)

    clean_user = username.strip().lower()
    clean_email = email.strip().lower() if email else None

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        existing = db.query(User).filter(User.username == clean_user).first()

        if clean_email:
            email_owner = db.query(User).filter(User.email == clean_email).first()
            if email_owner and (existing is None or email_owner.id != existing.id):
                raise ValueError(f"The email {clean_email} is already used by another account.")

        if existing:
            logger.info("Existing user @%s found. Promoting to owner.", clean_user)
            existing.role = "owner"
            existing.password_hash = get_password_hash(password)
            existing.is_banned = False
            existing.ban_reason = None
            existing.ban_expires_at = None
            if clean_email:
                existing.email = clean_email
            if display_name:
                existing.display_name = display_name.strip()
            if existing.connect_code is None:
                existing.connect_code = _new_connect_code(db)
            if db.query(UserSettings).filter(UserSettings.user_id == existing.id).first() is None:
                db.add(UserSettings(user_id=existing.id, theme="dark", language="en"))
            owner = existing
            action = "OWNER_PROMOTED"
            reason = "Server-side bootstrap CLI promotion"
        else:
            logger.info("Creating new platform owner @%s.", clean_user)
            owner = User(
                username=clean_user,
                display_name=display_name.strip() if display_name else "Platform Owner",
                email=clean_email or f"{clean_user}@venteda.io",
                password_hash=get_password_hash(password),
                role="owner",
                bio="Venteda Chat Platform Administrator & Owner",
                connect_code=_new_connect_code(db),
                privacy_mode="strict",
                is_online=False,
                created_at=datetime.utcnow(),
            )
            db.add(owner)
            db.flush()  # assigns owner.id without committing
            db.add(UserSettings(user_id=owner.id, theme="dark", language="en"))
            action = "OWNER_CREATED"
            reason = "Initial server-side bootstrap CLI initialization"

        db.add(AuditLog(
            actor_id=owner.id,
            actor_username="SYSTEM_BOOTSTRAP",
            action=action,
            target_type="user",
            target_id=owner.id,
            reason=reason,
        ))
        db.commit()
        db.refresh(owner)
        logger.info("Owner @%s is ready (id: %s).", clean_user, owner.id)
        return owner
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Create or promote the platform owner account.")
    parser.add_argument("--username", "-u", default="owner", help="Owner username (default: owner)")
    parser.add_argument("--password", "-p", required=True, help="Owner password (at least 8 characters)")
    parser.add_argument("--email", "-e", default=None, help="Owner email address")
    parser.add_argument("--name", "-n", default=None, help="Display name (default: Platform Owner)")
    args = parser.parse_args()

    try:
        bootstrap_owner(
            username=args.username,
            password=args.password,
            email=args.email,
            display_name=args.name,
        )
    except ValueError as exc:
        logger.error("%s", exc)
        sys.exit(1)


if __name__ == "__main__":
    main()
