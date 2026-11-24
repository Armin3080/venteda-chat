"""
ORM models package.

All model modules are imported here, once, so that SQLAlchemy knows every mapped class
before any query runs. Relationships refer to classes by name (for example "ConversationMember"),
so a model that is never imported makes mapper configuration fail. This affected the
owner bootstrap CLI, which only imported User. Importing the package fixes every entry point.
Model modules depend only on app.core.database, so this does not create circular imports.
"""
from app.models.user import User, UserSession, UserSettings
from app.models.conversation import Conversation, ConversationMember
from app.models.message import Message, MessageReaction
from app.models.attachment import Attachment
from app.models.admin import AuditLog, ModerationReport
from app.models.call import CallRecord
from app.models.contact import UserContact
from app.models.story import Story, StoryView
from app.models.saved_media import SavedMedia
from app.models.admin_note import AdminNote

__all__ = [
    "User", "UserSession", "UserSettings",
    "Conversation", "ConversationMember",
    "Message", "MessageReaction",
    "Attachment",
    "AuditLog", "ModerationReport",
    "CallRecord",
    "UserContact",
    "Story", "StoryView",
    "SavedMedia",
    "AdminNote",
]
