from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from typing import Dict, Optional
from datetime import datetime, timedelta
import asyncio
import uuid
import secrets
import logging

from backend.database import get_db, async_session_maker
from backend.models import Project, ProjectMember, ProjectInvite, User, Publication, Upload
from backend.models.storage_backend import get_allowed_storage_backends
from backend.models.project_export import ProjectExport, ProjectImport
from backend.services.auth_service import get_current_user, get_current_user_optional, require_project_member, AuthContext
from backend.services.storage_credentials import ensure_ready
from backend.services.email_service import send_invite_email
from backend.services.project_export_service import run_export
from backend.services.project_import_service import run_import
from backend.config import settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/projects", tags=["Projects"])


async def _setup_storage_background(project_id: str, force: bool = False):
    async with async_session_maker() as db:
        result = await db.execute(select(Project).where(Project.id == project_id))
        proj = result.scalar_one_or_none()
        if not proj:
            return
        try:
            await ensure_ready(db, proj, force=force)
            proj.storage_status = "ready"
            await db.commit()
        except Exception as e:
            logger.error(f"Exception during storage setup for project {project_id}: {e}", exc_info=True)
            proj.storage_status = "failed"
            await db.commit()


@router.get("", summary="List accessible projects")
async def list_projects(
    viewing_id: Optional[str] = None,
    auth: AuthContext | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db)
):
    """Return the projects the caller can see, in display order:
    [pinned currently-viewed publication] → [own projects] → [other findable publications].

    Each real project has an 'id' (UUID string) and a 'name'. A publication entry has
    'id' (the publication id, usable anywhere a project id is accepted, read-only),
    'name' (the underlying project's name with " (ro)" appended), 'read_only': true,
    and 'findable'.

    When authenticated via API key, own projects are restricted to the key's scoped
    project. When unauthenticated, own projects and other findable publications are
    omitted entirely — only 'viewing_id' (if it resolves to a valid, anonymous-allowed
    publication) is returned, as a single-entry list.
    """
    own_projects = []
    combined_ids = set()

    if auth is not None:
        stmt = (
            select(Project)
            .join(ProjectMember, ProjectMember.project_id == Project.id)
            .where(ProjectMember.user_id == auth.user.id)
            .order_by(Project.created_at)
        )
        # When authenticated via API key, restrict to the key's scoped project
        if auth.api_key_project_id is not None:
            stmt = stmt.where(Project.id == auth.api_key_project_id)
        result = await db.execute(stmt)
        own_projects = [p.to_dict() for p in result.scalars().all()]
        combined_ids = {p["id"] for p in own_projects}

        pub_stmt = (
            select(Publication)
            .options(selectinload(Publication.project))
            .where(Publication.findable == True)  # noqa: E712
            .order_by(Publication.created_at)
        )
        pub_result = await db.execute(pub_stmt)
        findable_entries = []
        for pub in pub_result.scalars().all():
            if pub.project_id in combined_ids:
                continue
            findable_entries.append({
                "id": pub.id,
                "name": f"{pub.project.name} (ro)",
                "created_at": pub.project.created_at.isoformat(),
                "storage_status": None,
                "read_only": True,
                "findable": True,
            })
        combined_ids |= {e["id"] for e in findable_entries}
    else:
        findable_entries = []

    result_list = own_projects + findable_entries

    if viewing_id and viewing_id not in combined_ids:
        pub_stmt = (
            select(Publication)
            .options(selectinload(Publication.project))
            .where(Publication.id == viewing_id)
        )
        pub_result = await db.execute(pub_stmt)
        publication = pub_result.scalar_one_or_none()
        if publication is not None and (publication.allow_anonymous or auth is not None):
            pinned_entry = {
                "id": publication.id,
                "name": f"{publication.project.name} (ro)",
                "created_at": publication.project.created_at.isoformat(),
                "storage_status": None,
                "read_only": True,
                "findable": publication.findable,
            }
            result_list = [pinned_entry] + result_list

    return result_list


@router.post("", summary="Create a new project")
async def create_project(
    project: Dict,
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Create a new project and provision its storage bucket.

    Body: { "name": "My Project", "storage_backend_id": "<id>" }. storage_backend_id is
    required — call GET /utilities/available-storage-backends first to get the allowed set.

    Returns the new project record including its id. Storage setup runs
    asynchronously; the project is immediately usable for submitting jobs.
    """
    storage_backend_id = project.get("storage_backend_id")
    if not storage_backend_id:
        raise HTTPException(status_code=400, detail="storage_backend_id is required")

    allowed = await get_allowed_storage_backends(db, auth.user)
    backend = next((b for b in allowed if b.id == storage_backend_id), None)
    if backend is None:
        raise HTTPException(status_code=400, detail=f"Storage backend {storage_backend_id} is not allowed for this request.")

    project_id = str(uuid.uuid4())
    proj = Project(
        id=project_id,
        name=project.get("name", "Unnamed Project"),
        created_at=datetime.utcnow(),
        storage_status="pending",
        storage_backend_id=backend.id,
    )
    db.add(proj)

    member = ProjectMember(
        project_id=project_id,
        user_id=auth.user.id,
        joined_at=datetime.utcnow()
    )
    db.add(member)
    await db.commit()
    await db.refresh(proj)

    asyncio.create_task(_setup_storage_background(project_id))
    return proj.to_dict()


@router.post("/{project_id}/setup-storage", summary="Re-trigger storage setup for a project")
async def setup_storage(
    project: Project = Depends(require_project_member),
    db: AsyncSession = Depends(get_db)
):
    """Re-run storage provisioning (bucket, IAM user, k8s secret) for a project.

    Safe to call repeatedly — all steps are idempotent. Useful when the
    background task that runs on project creation failed silently.
    The endpoint returns immediately; check storage_status on the project
    to know when it completes.
    """
    project.storage_status = "pending"
    await db.commit()
    asyncio.create_task(_setup_storage_background(project.id, force=True))
    return {"status": "pending", "project_id": project.id}


@router.post("/{project_id}/export", summary="Export a project as a downloadable zip archive")
async def export_project(
    project: Project = Depends(require_project_member),
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Start a background job that packs this project (processes, versions, output datasets,
    uploads, and tags) into a zip archive. Poll GET /projects/{project_id}/export/{export_id}
    for progress; once state is "done", it returns a download_url.
    """
    export_row = ProjectExport(project_id=project.id, created_by_id=auth.user.id)
    db.add(export_row)
    await db.commit()
    await db.refresh(export_row)

    asyncio.create_task(run_export(project.id, export_row.id))
    return export_row.to_dict()


@router.get("/{project_id}/export/{export_id}", summary="Poll a project export job")
async def get_project_export(
    export_id: str,
    project: Project = Depends(require_project_member),
    db: AsyncSession = Depends(get_db)
):
    stmt = select(ProjectExport).where(ProjectExport.id == export_id, ProjectExport.project_id == project.id)
    result = await db.execute(stmt)
    export_row = result.scalar_one_or_none()
    if not export_row:
        raise HTTPException(status_code=404, detail="Export not found")
    return export_row.to_dict()


@router.post("/import", summary="Import a project from a previously-uploaded export zip")
async def import_project(
    body: Dict,
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Start a background job that unpacks an export zip (submitted via the normal
    /projects/{project_id}/upload flow, into any project the caller is a member of) into a
    brand-new project owned solely by the caller. Body: { "upload_id": "<id>" }.
    Poll GET /projects/import/{import_id} for progress; once state is "done", it returns
    the new project_id.
    """
    upload_id = body.get("upload_id")
    if not upload_id:
        raise HTTPException(status_code=400, detail="upload_id is required")

    stmt = select(Upload).where(Upload.id == upload_id)
    result = await db.execute(stmt)
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Upload not found")

    import_row = ProjectImport(upload_id=upload_id, created_by_id=auth.user.id)
    db.add(import_row)
    await db.commit()
    await db.refresh(import_row)

    asyncio.create_task(run_import(import_row.id))
    return import_row.to_dict()


@router.get("/import/{import_id}", summary="Poll a project import job")
async def get_project_import(
    import_id: str,
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    stmt = select(ProjectImport).where(ProjectImport.id == import_id, ProjectImport.created_by_id == auth.user.id)
    result = await db.execute(stmt)
    import_row = result.scalar_one_or_none()
    if not import_row:
        raise HTTPException(status_code=404, detail="Import not found")
    return import_row.to_dict()


@router.get("/{project_id}/members", summary="List project members")
async def list_members(
    project: Project = Depends(require_project_member),
    db: AsyncSession = Depends(get_db)
):
    """List all users who are members of the given project."""
    stmt = (
        select(ProjectMember)
        .options(selectinload(ProjectMember.user))
        .where(ProjectMember.project_id == project.id)
        .order_by(ProjectMember.joined_at)
    )
    result = await db.execute(stmt)
    members = result.scalars().all()
    return [m.to_dict() for m in members]


@router.get("/{project_id}/invites")
async def list_invites(
    project: Project = Depends(require_project_member),
    db: AsyncSession = Depends(get_db)
):
    """List pending (unexpired, unaccepted) invites for a project"""
    now = datetime.utcnow()
    stmt = (
        select(ProjectInvite)
        .options(selectinload(ProjectInvite.invited_by))
        .where(
            ProjectInvite.project_id == project.id,
            ProjectInvite.accepted_at == None,  # noqa: E711
            ProjectInvite.expires_at > now
        )
        .order_by(ProjectInvite.created_at.desc())
    )
    result = await db.execute(stmt)
    invites = result.scalars().all()
    invite_dicts = []
    for inv in invites:
        d = inv.to_dict(include_token=True)
        d["invite_url"] = f"{settings.frontend_base_url}/invite/{inv.token}"
        invite_dicts.append(d)
    return invite_dicts


@router.post("/{project_id}/invites")
async def create_invite(
    body: Dict,
    project: Project = Depends(require_project_member),
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Create an invite link; optionally also send an email."""
    email = body.get("email") or None
    now = datetime.utcnow()

    if email:
        # Guard: email already a member?
        existing_user_stmt = select(User).where(User.email == email)
        existing_user_result = await db.execute(existing_user_stmt)
        existing_user = existing_user_result.scalar_one_or_none()
        if existing_user:
            member_stmt = select(ProjectMember).where(
                ProjectMember.project_id == project.id,
                ProjectMember.user_id == existing_user.id
            )
            member_result = await db.execute(member_stmt)
            if member_result.scalar_one_or_none():
                raise HTTPException(status_code=400, detail="User is already a member of this project")

        # Guard: pending invite already exists for this email?
        pending_stmt = select(ProjectInvite).where(
            ProjectInvite.project_id == project.id,
            ProjectInvite.email == email,
            ProjectInvite.accepted_at == None,  # noqa: E711
            ProjectInvite.expires_at > now
        )
        pending_result = await db.execute(pending_stmt)
        if pending_result.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="A pending invite already exists for this email")

    token = secrets.token_urlsafe(32)
    invite = ProjectInvite(
        project_id=project.id,
        email=email,
        token=token,
        invited_by_id=auth.user.id,
        created_at=now,
        expires_at=now + timedelta(days=7),
    )
    db.add(invite)
    await db.commit()

    invite_url = f"{settings.frontend_base_url}/invite/{token}"

    if email:
        await send_invite_email(
            to_email=email,
            inviter_name=auth.user.username,
            project_name=project.name,
            token=token
        )

    return {
        "id": invite.id,
        "project_id": invite.project_id,
        "email": invite.email,
        "invited_by": auth.user.username,
        "created_at": invite.created_at.isoformat(),
        "expires_at": invite.expires_at.isoformat(),
        "accepted_at": None,
        "token": token,
        "invite_url": invite_url,
    }


@router.delete("/{project_id}/invites/{invite_id}")
async def cancel_invite(
    invite_id: str,
    project: Project = Depends(require_project_member),
    db: AsyncSession = Depends(get_db)
):
    """Cancel a pending invite"""
    stmt = select(ProjectInvite).where(
        ProjectInvite.id == invite_id,
        ProjectInvite.project_id == project.id
    )
    result = await db.execute(stmt)
    invite = result.scalar_one_or_none()
    if not invite:
        raise HTTPException(status_code=404, detail="Invite not found")

    await db.delete(invite)
    await db.commit()
    return {"message": "Invite cancelled"}


@router.delete("/{project_id}/members/me")
async def leave_project(
    project: Project = Depends(require_project_member),
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Leave a project"""
    stmt = select(ProjectMember).where(
        ProjectMember.project_id == project.id,
        ProjectMember.user_id == auth.user.id
    )
    result = await db.execute(stmt)
    member = result.scalar_one_or_none()
    if member:
        await db.delete(member)
        await db.commit()
    return {"message": "Left project"}
