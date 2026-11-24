"""Story endpoints: post, feed, view, viewers, delete.

Visibility: a story is seen by people who saved each other (the author's contacts),
and by everyone when staff publish it as a platform-wide story.
"""
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.story import Story, StoryView
from app.models.user import User
from app.schemas.story import StoryFeedItem, StoryResponse, StoryViewerResponse
from app.services.auth_service import get_current_user
from app.services.story_service import (
    STORY_TTL,
    active_query,
    can_view_story,
    delete_story,
    followers_of,
    sees_author,
    purge_expired,
    media_exists,
    save_story_media,
    visible_author_ids,
    visible_stories_query,
)
from app.websocket.manager import manager

router = APIRouter(prefix="/api/stories", tags=["stories"])
STAFF_ROLES = ("owner", "moderator")


def _viewed_ids(db: Session, viewer_id: str, story_ids: List[str]) -> set:
    if not story_ids:
        return set()
    rows = db.query(StoryView.story_id).filter(
        StoryView.viewer_id == viewer_id, StoryView.story_id.in_(story_ids)).all()
    return {r[0] for r in rows}


def _to_response(s: Story, viewed: bool, view_count: Optional[int] = None) -> StoryResponse:
    return StoryResponse(
        id=s.id, author_id=s.author_id, media_url=s.media_url, media_type=s.media_type,
        caption=s.caption, created_at=s.created_at, expires_at=s.expires_at,
        is_platform=bool(s.is_platform), viewed=viewed, view_count=view_count,
    )


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Story not found.")


@router.post("", response_model=StoryResponse, status_code=status.HTTP_201_CREATED)
async def create_story(
    file: UploadFile = File(...),
    caption: Optional[str] = Form(None),
    platform: bool = Form(False),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if platform and current_user.role not in STAFF_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="Only administrators can publish stories for everyone.")
    purge_expired(db)
    url, media_type = await save_story_media(file)
    now = datetime.utcnow()
    story = Story(
        author_id=current_user.id,
        media_url=url,
        media_type=media_type,
        caption=(caption or "").strip()[:300] or None,
        is_platform=bool(platform),
        created_at=now,
        expires_at=now + STORY_TTL,
    )
    db.add(story)
    db.commit()
    db.refresh(story)

    # Push the update so each audience member's bar refreshes immediately
    if platform:
        audience = set(manager.active_users.keys()) - {current_user.id}
    else:
        audience = set(followers_of(db, current_user.id))
    if audience:
        await manager.broadcast_to_users({"event": "story_update", "data": {"author_id": current_user.id}}, audience)
    return _to_response(story, viewed=True)


@router.get("/feed", response_model=List[StoryFeedItem])
def story_feed(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Your own stories, then contacts who saved you back, then platform-wide stories."""
    purge_expired(db)
    platform_rows = db.query(Story.author_id).filter(
        Story.is_platform.is_(True), Story.expires_at > datetime.utcnow()).distinct().all()
    candidates = [current_user.id] + visible_author_ids(db, current_user.id)
    candidates += [r[0] for r in platform_rows if r[0] not in candidates]

    items: List[StoryFeedItem] = []
    for uid in candidates:
        stories = [s for s in visible_stories_query(db, current_user.id, uid).order_by(Story.created_at).all()
                   if media_exists(s.media_url)]
        if not stories:
            continue
        user = db.query(User).filter(User.id == uid).first()
        if not user:
            continue
        viewed = _viewed_ids(db, current_user.id, [s.id for s in stories])
        is_me = uid == current_user.id
        items.append(StoryFeedItem(
            user_id=uid,
            display_name=user.display_name,
            avatar_url=user.avatar_url,
            count=len(stories),
            unseen=(not is_me) and any(s.id not in viewed for s in stories),
            latest_at=stories[-1].created_at,
            is_me=is_me,
            is_platform=any(s.is_platform for s in stories),
        ))
    items.sort(key=lambda i: (not i.is_me, not i.unseen, -i.latest_at.timestamp()))
    return items


@router.get("/user/{user_id}", response_model=List[StoryResponse])
def user_stories(user_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    purge_expired(db)
    stories = [s for s in visible_stories_query(db, current_user.id, user_id).order_by(Story.created_at).all()
               if media_exists(s.media_url)]
    if not stories and not sees_author(db, current_user.id, user_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No stories to show.")
    is_me = user_id == current_user.id
    viewed = _viewed_ids(db, current_user.id, [s.id for s in stories])
    result = []
    for s in stories:
        count = db.query(StoryView).filter(StoryView.story_id == s.id).count() if is_me else None
        result.append(_to_response(s, viewed=is_me or s.id in viewed, view_count=count))
    return result


@router.post("/{story_id}/view")
def mark_story_viewed(story_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    story = active_query(db).filter(Story.id == story_id).first()
    if not story or not can_view_story(db, current_user.id, story):
        raise _not_found()
    if story.author_id != current_user.id:
        exists = db.query(StoryView.id).filter(
            StoryView.story_id == story.id, StoryView.viewer_id == current_user.id).first()
        if not exists:
            try:
                db.add(StoryView(story_id=story.id, viewer_id=current_user.id))
                db.commit()
            except IntegrityError:
                db.rollback()
    return {"ok": True}


@router.get("/{story_id}/viewers", response_model=List[StoryViewerResponse])
def story_viewers(story_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    story = active_query(db).filter(Story.id == story_id).first()
    if not story or story.author_id != current_user.id:
        raise _not_found()
    rows = db.query(StoryView, User).join(User, User.id == StoryView.viewer_id).filter(
        StoryView.story_id == story.id).order_by(StoryView.viewed_at.desc()).all()
    return [StoryViewerResponse(user_id=u.id, username=u.username, display_name=u.display_name,
                                avatar_url=u.avatar_url, viewed_at=v.viewed_at)
            for v, u in rows]


@router.delete("/{story_id}")
def remove_story(story_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    story = db.query(Story).filter(Story.id == story_id).first()
    if not story or story.author_id != current_user.id:
        raise _not_found()
    delete_story(db, story)
    return {"ok": True}
