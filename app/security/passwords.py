"""Password hashing: bcrypt (cost 12) for new hashes, with verification of legacy PBKDF2 hashes."""
import hashlib
import hmac

import bcrypt

BCRYPT_ROUNDS = 12


def get_password_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=BCRYPT_ROUNDS)).decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    if not plain_password or not hashed_password:
        return False
    try:
        if hashed_password.startswith(("$2a$", "$2b$", "$2y$")):
            return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))
        if hashed_password.startswith("pbkdf2$"):
            _, iterations, salt_hex, hash_hex = hashed_password.split("$")
            computed = hashlib.pbkdf2_hmac(
                "sha256", plain_password.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations)
            ).hex()
            return hmac.compare_digest(computed, hash_hex)
    except (ValueError, TypeError):
        return False
    return False
