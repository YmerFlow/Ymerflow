from dataclasses import dataclass, field
from passlib.context import CryptContext
from jose import JWTError, jwt
from datetime import datetime, timedelta
from fastapi import Depends, HTTPException, status, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload
import hashlib
import logging

from backend.config import settings
from backend.models import User, Project, ProjectMember, Publication
from backend.database import get_db

logger = logging.getLogger(__name__)

# Password hashing context
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# HTTP Bearer token scheme - auto_error=False to handle errors ourselves
security = HTTPBearer(auto_error=False)


@dataclass
class AuthContext:
    user: User
    # None → JWT / not API-key-scoped → full access to the user's memberships.
    # frozenset (possibly empty) → API-key-scoped to exactly those projects.
    api_key_project_ids: frozenset[str] | None = None
    # The API key's id when authenticated via an "apk_" key — lets create_project
    # auto-add the newly-created project into this key's scope. None for JWT and
    # upload-token sessions.
    api_key_id: str | None = None


def hash_password(password: str) -> str:
    """Hash a password using bcrypt"""
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a password against a hash"""
    return pwd_context.verify(plain_password, hashed_password)


def hash_api_key(raw_key: str) -> str:
    """SHA-256 hash of an API key for storage/lookup"""
    return hashlib.sha256(raw_key.encode()).hexdigest()


def create_access_token(data: dict, expires_delta: timedelta = None) -> str:
    """Create a JWT access token"""
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(days=settings.access_token_expire_days)

    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)
    return encoded_jwt


def decode_access_token(token: str) -> dict:
    """Decode and validate a JWT access token"""
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        return payload
    except JWTError:
        return None


async def authenticate_token(token: str, db: AsyncSession) -> AuthContext | None:
    """Resolve a raw bearer token to an AuthContext, or None if it is missing/invalid/expired.

    Handles all three token shapes — JWT, 'apk_' API key, and 'upt_' upload token — and is the
    injectable core of get_current_user: it takes the raw token string rather than the
    HTTPBearer(Request) credentials, so it can also be called from a @router.websocket handler
    that reads the token as its first message (see docs/plans/done/ws-data-leak-fixes.md).

    Never logs the raw token. Returns None on any invalid credential (so callers decide how to
    surface the failure); lets unexpected errors propagate (CLAUDE.md rule 8).
    """
    if not token:
        return None

    # Upload token path: tokens prefixed with "upt_"
    if token.startswith("upt_"):
        jwt_part = token[4:]
        payload = decode_access_token(jwt_part)
        if payload is None or payload.get("token_type") != "upload":
            return None

        uid = payload.get("uid")
        project_id = payload.get("project_id")
        if uid is None or project_id is None:
            return None

        stmt = select(User).where(User.id == uid)
        result = await db.execute(stmt)
        user = result.scalar_one_or_none()
        if user is None:
            return None

        logger.info(f"Upload token auth: user '{user.username}', project '{project_id}'")
        return AuthContext(user=user, api_key_project_ids=frozenset({project_id}), api_key_id=None)

    # API key path: tokens prefixed with "apk_"
    if token.startswith("apk_"):
        from backend.models.api_key import ApiKey
        key_hash = hash_api_key(token)
        stmt = (
            select(ApiKey)
            .options(selectinload(ApiKey.user), selectinload(ApiKey.projects))
            .where(ApiKey.key_hash == key_hash)
        )
        result = await db.execute(stmt)
        api_key = result.scalar_one_or_none()

        if api_key is None:
            return None

        if api_key.expires_at is not None and api_key.expires_at < datetime.utcnow():
            return None

        # Mark as used; the endpoint's own commit will persist this
        api_key.last_used_at = datetime.utcnow()

        project_ids = frozenset(p.id for p in api_key.projects)
        logger.info(f"API key auth: user '{api_key.user.username}', projects {sorted(project_ids)}")
        return AuthContext(user=api_key.user, api_key_project_ids=project_ids, api_key_id=api_key.id)

    # JWT path
    payload = decode_access_token(token)
    if payload is None:
        return None

    username: str = payload.get("sub")
    if username is None:
        return None

    stmt = select(User).where(User.username == username)
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()

    if user is None:
        return None

    logger.info(f"JWT auth: user '{username}'")
    return AuthContext(user=user, api_key_project_ids=None, api_key_id=None)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db)
) -> AuthContext:
    """Get the current authenticated user from JWT token or API key.

    Returns AuthContext with the user and, when authenticated via API key,
    the project the key is scoped to.
    """
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header missing",
            headers={"WWW-Authenticate": "Bearer"},
        )

    auth = await authenticate_token(credentials.credentials, db)
    if auth is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return auth


async def get_current_user_optional(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db)
) -> AuthContext | None:
    """Same as get_current_user, but returns None instead of raising on missing/invalid
    credentials. Used to distinguish "anonymous but publication allows it" from "not
    authenticated at all" in resolve_project_for_read.
    """
    try:
        return await get_current_user(credentials=credentials, db=db)
    except HTTPException:
        return None


async def require_project_member(
    project_id: str,
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> Project:
    """Dependency that verifies the current user is a member of project_id.

    When authenticated via API key, also enforces that the key is scoped to
    this exact project (dual-gate: membership AND key scope must both pass).
    """
    # Gate 1: API key scope (cheap, no DB round-trip)
    if auth.api_key_project_ids is not None and project_id not in auth.api_key_project_ids:
        raise HTTPException(status_code=403, detail="API key is not scoped to this project")

    # Gate 2: user membership
    stmt = (
        select(Project)
        .join(ProjectMember, ProjectMember.project_id == Project.id)
        .where(Project.id == project_id, ProjectMember.user_id == auth.user.id)
    )
    result = await db.execute(stmt)
    project = result.scalar_one_or_none()
    if project:
        return project

    # Not a member — distinguish "valid publication link, but it's read-only" from a
    # plain not-found/not-a-member so publication viewers get an informative 403.
    pub_stmt = select(Publication).where(Publication.id == project_id)
    pub_result = await db.execute(pub_stmt)
    if pub_result.scalar_one_or_none() is not None:
        raise HTTPException(status_code=403, detail="This is a read-only publication link — cannot write")

    raise HTTPException(status_code=403, detail="Not a member of this project")


async def _is_project_member(db: AsyncSession, project_id: str, auth: AuthContext) -> bool:
    """True iff `auth` has REAL membership of `project_id` (and, for API-key auth, the key is
    scoped to it) — the same dual-gate as require_project_member, minus the HTTP raising.

    Real membership ONLY: this never falls back to the publication/anonymous read path, so
    publication and anonymous viewers get no live logs feed (operator decision — see
    docs/plans/done/ws-data-leak-fixes.md). Used by the authenticated logs WebSocket.
    """
    # Gate 1: API key scope (cheap, no DB round-trip)
    if auth.api_key_project_ids is not None and project_id not in auth.api_key_project_ids:
        return False

    # Gate 2: real user membership
    stmt = (
        select(Project.id)
        .join(ProjectMember, ProjectMember.project_id == Project.id)
        .where(Project.id == project_id, ProjectMember.user_id == auth.user.id)
    )
    result = await db.execute(stmt)
    return result.scalar_one_or_none() is not None


@dataclass
class ProjectReadAccess:
    project: Project
    read_only: bool
    publication: Publication | None = None


def _deep_str_replace(payload, old: str, new: str):
    """Recursively walk a JSON-shaped payload (dicts/lists/primitives) and substring-replace
    `old` with `new` in every string. Returns a new structure; does not mutate in place."""
    if isinstance(payload, dict):
        return {k: _deep_str_replace(v, old, new) for k, v in payload.items()}
    if isinstance(payload, list):
        return [_deep_str_replace(item, old, new) for item in payload]
    if isinstance(payload, str):
        return payload.replace(old, new)
    return payload


def redact_project_id(payload, access: ProjectReadAccess):
    """When serving through a publication link, swap the real project id for the publication id
    everywhere it appears — project_id JSON fields, /projects/<id>/... metadata URLs, and
    /files/<bucket_prefix><id>/... file URLs — so a viewer handed only a publication id never
    sees the underlying real project id. No-op for real-membership reads.

    The replaced value is a full uuid4, so a plain substring replace is safe: it cannot
    plausibly appear as a substring of any non-id field in a JSON metadata response. See
    docs/plans/done/publication-link-id-opacity.md."""
    if not access.read_only or access.publication is None:
        return payload
    return _deep_str_replace(payload, access.project.id, access.publication.id)


async def try_resolve_project_for_read(
    project_id: str,
    auth: AuthContext | None,
    db: AsyncSession,
) -> ProjectReadAccess | None:
    """Pure (dependency-free) resolver for read access to a project.

    Resolves `project_id` as either a real project (real membership required) or a Publication
    id (read-only, optionally anonymous), returning a `ProjectReadAccess` on success or `None`
    when the caller has no read access for any reason (unknown id, or a non-anonymous
    publication accessed anonymously). The `resolve_project_for_read` dependency wraps this and
    maps `None` to the appropriate 404/401; other callers (e.g. `_can_read_workspace`) use the
    boolean-ish result directly. Keeping the "real-membership-or-publication, honor
    allow_anonymous" logic here means it lives in exactly one place.
    """
    # Try real membership first (same query as require_project_member, but a miss falls
    # through to the publication lookup below instead of raising).
    if auth is not None and (auth.api_key_project_ids is None or project_id in auth.api_key_project_ids):
        stmt = (
            select(Project)
            .join(ProjectMember, ProjectMember.project_id == Project.id)
            .where(Project.id == project_id, ProjectMember.user_id == auth.user.id)
        )
        result = await db.execute(stmt)
        project = result.scalar_one_or_none()
        if project:
            return ProjectReadAccess(project=project, read_only=False, publication=None)

    pub_stmt = (
        select(Publication)
        .options(selectinload(Publication.project))
        .where(Publication.id == project_id)
    )
    pub_result = await db.execute(pub_stmt)
    publication = pub_result.scalar_one_or_none()
    if publication is None:
        return None

    if not publication.allow_anonymous and auth is None:
        return None

    return ProjectReadAccess(project=publication.project, read_only=True, publication=publication)


async def resolve_project_for_read(
    project_id: str,
    auth: AuthContext | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db)
) -> ProjectReadAccess:
    """Dependency for pure-read endpoints: resolves project_id as either a real project
    (real membership required) or a Publication id (read-only, optionally anonymous).
    """
    access = await try_resolve_project_for_read(project_id, auth, db)
    if access is not None:
        return access

    # No read access — distinguish "non-anonymous publication accessed anonymously" (401)
    # from "unknown id / not a member" (404). Only the error path re-checks the publication.
    pub_stmt = select(Publication).where(Publication.id == project_id)
    publication = (await db.execute(pub_stmt)).scalar_one_or_none()
    if publication is not None and not publication.allow_anonymous and auth is None:
        raise HTTPException(status_code=401, detail="Authentication required to view this publication")

    raise HTTPException(status_code=404, detail="Project not found")
