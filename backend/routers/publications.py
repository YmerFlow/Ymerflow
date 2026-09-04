from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from typing import Dict

from backend.database import get_db
from backend.models import Project, Publication
from backend.services.auth_service import (
    AuthContext,
    get_current_user,
    get_current_user_optional,
    require_project_member,
)

router = APIRouter(tags=["Publications"])


@router.post("/projects/{project_id}/publications", summary="Create a publication (read-only share link)")
async def create_publication(
    body: Dict,
    project: Project = Depends(require_project_member),
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a read-only publication link for this project.

    Body: {"findable": bool = false, "allow_anonymous": bool = true}.

    - findable: if true, this publication shows up in every user's Projects list
      (after their own projects), so it can be discovered without the link.
    - allow_anonymous: if true (default), the link works with no session at all;
      if false, viewers must be logged in (as any user) to open it.
    """
    publication = Publication(
        project_id=project.id,
        findable=bool(body.get("findable", False)),
        allow_anonymous=bool(body.get("allow_anonymous", True)),
        created_by=auth.user.id,
    )
    db.add(publication)
    await db.commit()
    await db.refresh(publication)
    return publication.to_dict()


@router.get("/projects/{project_id}/publications", summary="List publications for a project")
async def list_publications(
    project: Project = Depends(require_project_member),
    db: AsyncSession = Depends(get_db),
):
    """List all publication links for this project."""
    stmt = (
        select(Publication)
        .where(Publication.project_id == project.id)
        .order_by(Publication.created_at)
    )
    result = await db.execute(stmt)
    return [p.to_dict() for p in result.scalars().all()]


@router.delete("/projects/{project_id}/publications/{publication_id}", summary="Delete a publication")
async def delete_publication(
    publication_id: str,
    project: Project = Depends(require_project_member),
    db: AsyncSession = Depends(get_db),
):
    """Delete a publication link. It stops resolving immediately for anyone using it."""
    stmt = select(Publication).where(
        Publication.id == publication_id,
        Publication.project_id == project.id,
    )
    result = await db.execute(stmt)
    publication = result.scalar_one_or_none()
    if not publication:
        raise HTTPException(status_code=404, detail="Publication not found")

    await db.delete(publication)
    await db.commit()
    return {"status": "deleted"}


@router.get("/publications/public", operation_id="list_public_publications", summary="List all public (findable) publications", tags=["Projects"])
async def list_public_publications(
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Every publication marked public (findable), for the logged-in discovery combobox.

    Distinct from /publications/findable: that one is unauthenticated, for a not-yet-built
    logged-out discovery page. This one requires login and backs the search box at the
    bottom of the project toolbar dropdown.

    NOTE: registered before /publications/{publication_id} — FastAPI matches routes
    in registration order, and a literal path must come before a same-prefix
    {param} path or the param route would swallow it.
    """
    stmt = (
        select(Publication)
        .options(selectinload(Publication.project))
        .where(Publication.findable == True)  # noqa: E712
    )
    result = await db.execute(stmt)
    return [
        {"id": p.id, "project_name": p.project.name, "superpublic": p.superpublic}
        for p in result.scalars().all()
    ]


@router.patch("/projects/{project_id}/publications/{publication_id}", summary="Update a publication")
async def update_publication(
    publication_id: str,
    body: Dict,
    project: Project = Depends(require_project_member),
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Toggle a publication's public/superpublic flags.

    `findable` (public/searchable): any project member.
    `superpublic` (listed directly in everyone's menu): site admins only.
    Setting superpublic=true always also sets findable=true, regardless of what's in the body.
    """
    stmt = select(Publication).where(
        Publication.id == publication_id, Publication.project_id == project.id,
    )
    result = await db.execute(stmt)
    publication = result.scalar_one_or_none()
    if not publication:
        raise HTTPException(status_code=404, detail="Publication not found")

    if "superpublic" in body:
        if not auth.user.is_admin:
            raise HTTPException(status_code=403, detail="Admin access required")
        publication.superpublic = bool(body["superpublic"])
        if publication.superpublic:
            publication.findable = True
    if "findable" in body and not publication.superpublic:
        publication.findable = bool(body["findable"])

    await db.commit()
    await db.refresh(publication)
    return publication.to_dict()


@router.get("/publications/findable", summary="List all findable publications")
async def list_findable_publications(db: AsyncSession = Depends(get_db)):
    """Fully public: list every publication marked findable, for logged-out discovery.

    No UI in this app consumes this endpoint yet — it's a capability for a future
    logged-out discovery page.

    NOTE: registered before /publications/{publication_id} — FastAPI matches routes
    in registration order, and a literal path must come before a same-prefix
    {param} path or the param route would swallow it.
    """
    stmt = (
        select(Publication)
        .options(selectinload(Publication.project))
        .where(Publication.findable == True)  # noqa: E712
    )
    result = await db.execute(stmt)
    return [
        {"id": p.id, "project_name": p.project.name}
        for p in result.scalars().all()
    ]


@router.get("/publications/{publication_id}", summary="Resolve a publication link")
async def get_publication(
    publication_id: str,
    auth: AuthContext | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """Resolve a publication id to its project name and flags.

    Used by the frontend to check whether a publication link is valid and
    anonymous-viewable before deciding whether to prompt for login.

    Returns 401 if the publication requires authentication and the caller has
    no session; 404 if the publication doesn't exist.
    """
    stmt = (
        select(Publication)
        .options(selectinload(Publication.project))
        .where(Publication.id == publication_id)
    )
    result = await db.execute(stmt)
    publication = result.scalar_one_or_none()
    if not publication:
        raise HTTPException(status_code=404, detail="Publication not found")

    if not publication.allow_anonymous and auth is None:
        raise HTTPException(status_code=401, detail="Authentication required to view this publication")

    return {
        "id": publication.id,
        "project_id": publication.project_id,
        "project_name": publication.project.name,
        "findable": publication.findable,
        "allow_anonymous": publication.allow_anonymous,
    }
