from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload
from sqlalchemy import func
from typing import Any, Dict, Optional
from datetime import datetime
import asyncio
import secrets

from backend.database import get_db
from backend.models import User, Project, ProjectMember, ProjectInvite, ApiKey
from backend.models.tos import TosVersion, UserTosAcceptance
from backend.services.auth_service import (
    hash_password,
    verify_password,
    create_access_token,
    hash_api_key,
    get_current_user,
    AuthContext,
)
from backend.auth_deps import require_admin

router = APIRouter(prefix="/auth", tags=["Authentication"])


@router.post("/signup")
async def signup(credentials: Dict[str, Any], db: AsyncSession = Depends(get_db)):
    """Sign up with username and password"""
    import logging
    logger = logging.getLogger(__name__)

    username = credentials.get("username")
    password = credentials.get("password")
    email = credentials.get("email") or None
    agreed_tos_version = credentials.get("agreed_tos_version")

    if not username or not password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username and password are required"
        )

    try:
        stmt = select(User).where(User.username == username.lower())
        result = await db.execute(stmt)
        existing_user = result.scalar_one_or_none()

        if existing_user:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Username already exists"
            )

        latest_tos_stmt = select(TosVersion).order_by(TosVersion.version.desc()).limit(1)
        latest_tos_result = await db.execute(latest_tos_stmt)
        latest_tos = latest_tos_result.scalar_one_or_none()

        if latest_tos is not None and agreed_tos_version != latest_tos.version:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="You must agree to the current Terms of Service to sign up"
            )

        password_hash = await asyncio.to_thread(hash_password, password)
        user = User(
            username=username.lower(),
            email=email,
            password_hash=password_hash,
            preferences={}
        )
        db.add(user)
        await db.flush()

        if latest_tos is not None:
            db.add(UserTosAcceptance(user_id=user.id, tos_version_id=latest_tos.id))

        from backend.hooks import hooks
        await hooks.run_async.user_created(db, user)
        await db.commit()

        extra_opts = hooks.run.user_query_options()
        stmt = select(User).options(*extra_opts).where(User.id == user.id)
        result = await db.execute(stmt)
        user = result.scalar_one()

        access_token = create_access_token(data={"sub": user.username})

        return {
            "access_token": access_token,
            "token_type": "bearer",
            "user": user.to_dict()
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Signup error: {type(e).__name__}: {str(e)}", exc_info=True)
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Signup failed: {str(e)}"
        )


@router.get("/tos")
async def get_tos(db: AsyncSession = Depends(get_db)):
    """Public endpoint: returns the latest Terms of Service version, if any.

    {"version": None, "body": None} means no TosVersion exists yet (should not happen after the
    seeding migration, but is handled defensively).
    """
    stmt = select(TosVersion).order_by(TosVersion.version.desc()).limit(1)
    result = await db.execute(stmt)
    latest = result.scalar_one_or_none()

    if latest is None:
        return {"version": None, "body": None}

    return {"version": latest.version, "body": latest.body}


@router.post("/login")
async def login(credentials: Dict[str, str], db: AsyncSession = Depends(get_db)):
    """Login with username and password"""
    username = credentials.get("username")
    password = credentials.get("password")

    if not username or not password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username and password are required"
        )

    from backend.hooks import hooks
    extra_opts = hooks.run.user_query_options()
    stmt = select(User).options(*extra_opts).where(User.username == username.lower())
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()

    if not user or not await asyncio.to_thread(verify_password, password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    access_token = create_access_token(data={"sub": user.username})

    latest_tos_stmt = select(TosVersion).order_by(TosVersion.version.desc()).limit(1)
    latest_tos_result = await db.execute(latest_tos_stmt)
    latest_tos = latest_tos_result.scalar_one_or_none()

    tos_pending = None
    if latest_tos is not None:
        accepted_stmt = (
            select(func.max(TosVersion.version))
            .join(UserTosAcceptance, UserTosAcceptance.tos_version_id == TosVersion.id)
            .where(UserTosAcceptance.user_id == user.id)
        )
        accepted_result = await db.execute(accepted_stmt)
        accepted_version = accepted_result.scalar_one_or_none()

        if accepted_version is None or accepted_version < latest_tos.version:
            tos_pending = {"version": latest_tos.version, "body": latest_tos.body}

    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": user.to_dict(),
        "tos_pending": tos_pending,
    }


@router.post("/forgot-password")
async def forgot_password(data: Dict[str, str]):
    """Placeholder for password reset (not implemented yet)"""
    return {
        "message": "Password reset not implemented yet. Please contact support."
    }


@router.get("/account")
async def get_account(
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get current user account information"""
    from backend.hooks import hooks
    extra_opts = hooks.run.user_query_options()
    stmt = select(User).options(*extra_opts).where(User.id == auth.user.id)
    result = await db.execute(stmt)
    user = result.scalar_one()
    return user.to_dict()


@router.put("/account/preferences")
async def update_preferences(
    preferences: Dict,
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update user preferences"""
    auth.user.preferences = preferences
    await db.commit()

    from backend.hooks import hooks
    extra_opts = hooks.run.user_query_options()
    stmt = select(User).options(*extra_opts).where(User.id == auth.user.id)
    result = await db.execute(stmt)
    user = result.scalar_one()

    return user.to_dict()


@router.put("/account/email")
async def update_email(
    body: Dict[str, Optional[str]],
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update the current user's email (the real users.email column, not preferences)."""
    email = body.get("email") or None
    auth.user.email = email
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=400, detail="This email is already associated with another account.")

    from backend.hooks import hooks
    extra_opts = hooks.run.user_query_options()
    stmt = select(User).options(*extra_opts).where(User.id == auth.user.id)
    result = await db.execute(stmt)
    user = result.scalar_one()
    return user.to_dict()


@router.post("/tos/accept")
async def accept_tos(
    body: Dict,
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Record that the current user has agreed to a given ToS version."""
    version = body.get("version")
    if not isinstance(version, int):
        raise HTTPException(status_code=400, detail="version is required")

    stmt = select(TosVersion).where(TosVersion.version == version)
    result = await db.execute(stmt)
    tos_version = result.scalar_one_or_none()

    if tos_version is None:
        raise HTTPException(status_code=404, detail="Terms of Service version not found")

    db.add(UserTosAcceptance(user_id=auth.user.id, tos_version_id=tos_version.id))
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()  # already accepted this version — not an error

    return {"version": version}


@router.get("/invites/{token}")
async def get_invite_info(token: str, db: AsyncSession = Depends(get_db)):
    """Public endpoint: returns invite metadata so the UI can greet the invitee."""
    now = datetime.utcnow()
    stmt = (
        select(ProjectInvite)
        .options(selectinload(ProjectInvite.project), selectinload(ProjectInvite.invited_by))
        .where(
            ProjectInvite.token == token,
            ProjectInvite.accepted_at == None,  # noqa: E711
            ProjectInvite.expires_at > now
        )
    )
    result = await db.execute(stmt)
    invite = result.scalar_one_or_none()

    if not invite:
        raise HTTPException(status_code=404, detail="Invite not found or expired")

    return {
        "email": invite.email,
        "project_name": invite.project.name if invite.project else None,
        "inviter": invite.invited_by.username if invite.invited_by else None,
    }


@router.post("/invites/{token}/accept")
async def accept_invite(
    token: str,
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Accept a project invite. User must be authenticated."""
    now = datetime.utcnow()
    stmt = (
        select(ProjectInvite)
        .options(selectinload(ProjectInvite.project))
        .where(
            ProjectInvite.token == token,
            ProjectInvite.accepted_at == None,  # noqa: E711
            ProjectInvite.expires_at > now
        )
    )
    result = await db.execute(stmt)
    invite = result.scalar_one_or_none()

    if not invite:
        raise HTTPException(status_code=404, detail="Invite not found or expired")

    member_stmt = select(ProjectMember).where(
        ProjectMember.project_id == invite.project_id,
        ProjectMember.user_id == auth.user.id
    )
    member_result = await db.execute(member_stmt)
    if not member_result.scalar_one_or_none():
        member = ProjectMember(
            project_id=invite.project_id,
            user_id=auth.user.id,
            joined_at=now
        )
        db.add(member)

    invite.accepted_at = now
    await db.commit()

    return {
        "project_id": invite.project_id,
        "project_name": invite.project.name if invite.project else None,
    }


# ---------------------------------------------------------------------------
# API Key management
# ---------------------------------------------------------------------------

@router.post("/api-keys")
async def create_api_key(
    body: Dict,
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Create a new project-scoped API key. Returns the raw key once — store it securely."""
    label = body.get("label", "").strip()
    project_id = body.get("project_id", "").strip()
    expires_at_str: Optional[str] = body.get("expires_at")

    if not label:
        raise HTTPException(status_code=400, detail="label is required")
    if not project_id:
        raise HTTPException(status_code=400, detail="project_id is required")

    # Verify the user is a member of the target project
    member_stmt = select(ProjectMember).where(
        ProjectMember.project_id == project_id,
        ProjectMember.user_id == auth.user.id
    )
    member_result = await db.execute(member_stmt)
    if not member_result.scalar_one_or_none():
        raise HTTPException(status_code=403, detail="Not a member of this project")

    expires_at = None
    if expires_at_str:
        try:
            expires_at = datetime.fromisoformat(expires_at_str)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid expires_at format (use ISO 8601)")

    raw_key = "apk_" + secrets.token_urlsafe(32)
    key_hash = hash_api_key(raw_key)

    # Load project for the response
    project_stmt = select(Project).where(Project.id == project_id)
    project_result = await db.execute(project_stmt)
    project = project_result.scalar_one_or_none()

    api_key = ApiKey(
        user_id=auth.user.id,
        project_id=project_id,
        label=label,
        key_hash=key_hash,
        expires_at=expires_at,
        created_at=datetime.utcnow(),
    )
    db.add(api_key)
    await db.commit()
    await db.refresh(api_key)

    return {
        **api_key.to_dict(),
        "project_name": project.name if project else None,
        "key": raw_key,  # returned exactly once
    }


@router.get("/api-keys")
async def list_api_keys(
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """List all API keys belonging to the current user."""
    stmt = (
        select(ApiKey)
        .options(selectinload(ApiKey.project))
        .where(ApiKey.user_id == auth.user.id)
        .order_by(ApiKey.created_at.desc())
    )
    result = await db.execute(stmt)
    keys = result.scalars().all()
    return [k.to_dict() for k in keys]


@router.delete("/api-keys/{key_id}")
async def delete_api_key(
    key_id: str,
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Revoke an API key. Only the owning user can delete their own keys."""
    stmt = select(ApiKey).where(ApiKey.id == key_id, ApiKey.user_id == auth.user.id)
    result = await db.execute(stmt)
    api_key = result.scalar_one_or_none()

    if not api_key:
        raise HTTPException(status_code=404, detail="API key not found")

    await db.delete(api_key)
    await db.commit()
    return {"message": "API key revoked"}


# ---------------------------------------------------------------------------
# Admin endpoints
# ---------------------------------------------------------------------------

SORTABLE_USER_COLUMNS = {
    "username": User.username,
    "email": User.email,
    "is_admin": User.is_admin,
}


@router.get("/admin/users")
async def admin_list_users(
    q: Optional[str] = None,
    sort: str = "username",
    dir: str = "asc",
    limit: int = 25,
    offset: int = 0,
    auth: AuthContext = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """List users (admin only), server-side paged, sorted and searched.

    Returns ``{"items": [...], "total": N}`` where ``total`` is the count *after* the ``q`` filter.
    """
    limit = max(1, min(limit, 200))
    offset = max(0, offset)
    sort_col = SORTABLE_USER_COLUMNS.get(sort, User.username)
    order = sort_col.desc() if dir == "desc" else sort_col.asc()

    base = select(User)
    if q:
        # Match q as a literal substring: escape LIKE wildcards in user input so % and _ aren't
        # treated as wildcards. lower()-wrapping keeps this DB-agnostic (Postgres prod / SQLite dev).
        needle = "%" + q.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        base = base.where(or_(
            func.lower(User.username).like(needle, escape="\\"),
            func.lower(User.email).like(needle, escape="\\"),
        ))

    total = await db.scalar(select(func.count()).select_from(base.subquery()))

    # Secondary username tiebreak keeps paging stable under low-cardinality sorts (e.g. is_admin).
    stmt = base.order_by(order, User.username.asc()).limit(limit).offset(offset)
    users = (await db.execute(stmt)).scalars().all()

    return {
        "items": [{"username": u.username, "email": u.email, "is_admin": u.is_admin} for u in users],
        "total": total,
    }


@router.put("/admin/users/{username}/admin")
async def admin_set_user_admin(
    username: str,
    body: Dict,
    auth: AuthContext = Depends(require_admin),
    db: AsyncSession = Depends(get_db)
):
    """Grant or revoke admin status for a user (admin only)."""
    if username.lower() == auth.user.username:
        raise HTTPException(status_code=400, detail="Cannot modify your own admin status")

    stmt = select(User).where(User.username == username.lower())
    result = await db.execute(stmt)
    target = result.scalar_one_or_none()

    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    is_admin = body.get("is_admin")
    if not isinstance(is_admin, bool):
        raise HTTPException(status_code=400, detail="is_admin must be a boolean")

    target.is_admin = is_admin
    await db.commit()
    return {"username": target.username, "is_admin": target.is_admin}
