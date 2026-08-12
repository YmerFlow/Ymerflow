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
    api_key_project_id: str | None = None


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


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db)
) -> AuthContext:
    """Get the current authenticated user from JWT token or API key.

    Returns AuthContext with the user and, when authenticated via API key,
    the project the key is scoped to.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header missing",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = credentials.credentials

    # Upload token path: tokens prefixed with "upt_"
    if token.startswith("upt_"):
        jwt_part = token[4:]
        payload = decode_access_token(jwt_part)
        if payload is None or payload.get("token_type") != "upload":
            raise credentials_exception

        uid = payload.get("uid")
        project_id = payload.get("project_id")
        if uid is None or project_id is None:
            raise credentials_exception

        stmt = select(User).where(User.id == uid)
        result = await db.execute(stmt)
        user = result.scalar_one_or_none()
        if user is None:
            raise credentials_exception

        logger.info(f"Upload token auth: user '{user.username}', project '{project_id}'")
        return AuthContext(user=user, api_key_project_id=project_id)

    # API key path: tokens prefixed with "apk_"
    if token.startswith("apk_"):
        from backend.models.api_key import ApiKey
        key_hash = hash_api_key(token)
        stmt = (
            select(ApiKey)
            .options(selectinload(ApiKey.user))
            .where(ApiKey.key_hash == key_hash)
        )
        result = await db.execute(stmt)
        api_key = result.scalar_one_or_none()

        if api_key is None:
            raise credentials_exception

        if api_key.expires_at is not None and api_key.expires_at < datetime.utcnow():
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="API key has expired",
                headers={"WWW-Authenticate": "Bearer"},
            )

        # Mark as used; the endpoint's own commit will persist this
        api_key.last_used_at = datetime.utcnow()

        logger.info(f"API key auth: user '{api_key.user.username}', project '{api_key.project_id}'")
        return AuthContext(user=api_key.user, api_key_project_id=api_key.project_id)

    # JWT path
    logger.info(f"Auth attempt - token: {token[:20]}..." if len(token) > 20 else f"Auth attempt - token: {token}")

    payload = decode_access_token(token)
    if payload is None:
        raise credentials_exception

    username: str = payload.get("sub")
    if username is None:
        raise credentials_exception

    stmt = select(User).where(User.username == username)
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()

    if user is None:
        raise credentials_exception

    logger.info(f"JWT auth: user '{username}'")
    return AuthContext(user=user, api_key_project_id=None)


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
    if auth.api_key_project_id is not None and auth.api_key_project_id != project_id:
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


@dataclass
class ProjectReadAccess:
    project: Project
    read_only: bool
    publication: Publication | None = None


async def resolve_project_for_read(
    project_id: str,
    auth: AuthContext | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db)
) -> ProjectReadAccess:
    """Dependency for pure-read endpoints: resolves project_id as either a real project
    (real membership required) or a Publication id (read-only, optionally anonymous).
    """
    # Try real membership first (same query as require_project_member, but a miss falls
    # through to the publication lookup below instead of raising).
    if auth is not None and (auth.api_key_project_id is None or auth.api_key_project_id == project_id):
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
        raise HTTPException(status_code=404, detail="Project not found")

    if not publication.allow_anonymous and auth is None:
        raise HTTPException(status_code=401, detail="Authentication required to view this publication")

    return ProjectReadAccess(project=publication.project, read_only=True, publication=publication)
