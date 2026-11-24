"""Connect PIN generation for private contact discovery."""
import secrets

from sqlalchemy.orm import Session

from app.models.user import User

PREFIX = "VNT-"
# No 0/O or 1/I so the PIN is easy to read and type
_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
_LENGTH = 6


def new_connect_code() -> str:
    return PREFIX + "".join(secrets.choice(_ALPHABET) for _ in range(_LENGTH))


def unique_connect_code(db: Session) -> str:
    """Return a code that no existing user has."""
    while True:
        code = new_connect_code()
        if db.query(User.id).filter(User.connect_code == code).first() is None:
            return code


def backfill_connect_codes(db: Session) -> int:
    """Give a PIN to every user who has none (accounts created before PINs were issued)."""
    missing = db.query(User).filter(User.connect_code.is_(None)).all()
    for user in missing:
        user.connect_code = unique_connect_code(db)
        db.flush()  # make the code visible to the next uniqueness check
    if missing:
        db.commit()
    return len(missing)
