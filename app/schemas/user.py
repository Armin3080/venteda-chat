from pydantic import BaseModel, EmailStr, Field
from typing import Optional, List
from datetime import datetime

class UserBase(BaseModel):
    username: str = Field(..., min_length=3, max_length=50)
    display_name: str = Field(..., min_length=1, max_length=100)
    email: Optional[EmailStr] = None
    bio: Optional[str] = Field(None, max_length=255)

class UserCreate(UserBase):
    password: str = Field(..., min_length=8, max_length=72)

class UserLogin(BaseModel):
    username: str
    password: str

class UserResponse(UserBase):
    id: str
    role: str = "user"
    avatar_url: Optional[str] = None
    privacy_mode: Optional[str] = "strict"
    is_banned: bool = False
    ban_reason: Optional[str] = None
    ban_expires_at: Optional[datetime] = None
    warning_count: int = 0
    is_online: bool = False
    last_seen: Optional[datetime] = None
    created_at: datetime

    class Config:
        from_attributes = True

class UserSelfResponse(UserResponse):
    """Returned only to the account owner. Includes the private Connect PIN."""
    connect_code: Optional[str] = None


class UserAdminResponse(UserResponse):
    """Returned only to staff in the admin panel."""
    connect_code: Optional[str] = None


class ConnectCodeVerifyRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=50)
    connect_code: str = Field(..., min_length=4, max_length=32)


class UserUpdate(BaseModel):
    display_name: Optional[str] = Field(None, min_length=1, max_length=100)
    email: Optional[EmailStr] = None
    bio: Optional[str] = Field(None, max_length=255)
    avatar_url: Optional[str] = None
    privacy_mode: Optional[str] = None
    username: Optional[str] = Field(None, min_length=3, max_length=32, pattern=r"^[A-Za-z0-9_]+$")

class PasswordChangeRequest(BaseModel):
    old_password: str
    new_password: str = Field(..., min_length=8, max_length=72)

class UserSettingsResponse(BaseModel):
    theme: str
    language: str
    notifications_enabled: bool
    sound_enabled: bool
    enter_is_send: bool
    wallpaper: Optional[str] = "mesh"
    glass_intensity: Optional[str] = "balanced"
    accent_color: Optional[str] = "#2685F6"
    bubble_style: Optional[str] = "soft"
    font_scale: Optional[str] = "medium"
    dnd_enabled: Optional[bool] = False
    dnd_start_hour: Optional[int] = 22
    dnd_end_hour: Optional[int] = 8
    media_auto_download: Optional[bool] = True
    compact_mode: Optional[bool] = False
    reduced_motion: Optional[bool] = False
    high_contrast: Optional[bool] = False

    class Config:
        from_attributes = True

class UserSettingsUpdate(BaseModel):
    theme: Optional[str] = None
    language: Optional[str] = None
    notifications_enabled: Optional[bool] = None
    sound_enabled: Optional[bool] = None
    enter_is_send: Optional[bool] = None
    wallpaper: Optional[str] = None
    glass_intensity: Optional[str] = None
    accent_color: Optional[str] = None
    bubble_style: Optional[str] = None
    font_scale: Optional[str] = None
    dnd_enabled: Optional[bool] = None
    dnd_start_hour: Optional[int] = None
    dnd_end_hour: Optional[int] = None
    media_auto_download: Optional[bool] = None
    compact_mode: Optional[bool] = None
    reduced_motion: Optional[bool] = None
    high_contrast: Optional[bool] = None

class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserSelfResponse
