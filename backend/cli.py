#!/usr/bin/env python3
"""
Nagelfluh CLI - Command-line tool for workspace management

Usage:
    python backend/cli.py workspace get <workspace_id>
    python backend/cli.py workspace save <workspace_id> <json_file>
    echo '{"title": "My Workspace", "layout": {...}}' | python backend/cli.py workspace save my-workspace -
"""

import json
import sys
import os
import click
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from dotenv import load_dotenv

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Load environment variables from config.env
load_dotenv("config.env")

# Import models
from backend.models.workspace import Workspace, WorkspaceVersion

DEFAULT_PROJECT_ID = "default-project-00000000-0000-0000-0000-000000000000"

# Get database URL from environment
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./nagelfluh.db")

# Convert to synchronous URL if needed (remove +aiosqlite)
if "+aiosqlite" in DATABASE_URL:
    DATABASE_URL = DATABASE_URL.replace("+aiosqlite", "")

# Create synchronous engine
engine = create_engine(DATABASE_URL, echo=False)
SessionLocal = sessionmaker(bind=engine)


@click.group()
def cli():
    """Nagelfluh CLI - Manage workspaces and more"""
    pass


@cli.group()
def workspace():
    """Workspace management commands"""
    pass


@workspace.command("get")
@click.argument("workspace_id")
@click.option("--pretty", is_flag=True, help="Pretty-print JSON output")
def get_workspace(workspace_id: str, pretty: bool):
    """Extract workspace definition as JSON

    Args:
        workspace_id: The ID or title of the workspace to retrieve
    """
    session = SessionLocal()
    try:
        # Try to find by ID first
        ws = session.query(Workspace).filter(Workspace.id == workspace_id).first()

        # If not found by ID, try by title
        if not ws:
            ws = session.query(Workspace).filter(Workspace.title == workspace_id).first()

        if not ws:
            click.echo(f"Error: Workspace '{workspace_id}' not found", err=True)
            sys.exit(1)

        # Convert to dictionary (includes full version history)
        workspace_data = ws.to_dict()

        # Output JSON
        if pretty:
            click.echo(json.dumps(workspace_data, indent=2))
        else:
            click.echo(json.dumps(workspace_data))

    finally:
        session.close()


@workspace.command("save")
@click.argument("workspace_id")
@click.argument("json_input", type=click.File("r"), default="-")
@click.option("--title", help="Override the title from JSON")
@click.option("--project", "project_id", default=DEFAULT_PROJECT_ID,
              help="Project ID the workspace belongs to (only used when creating a new workspace)")
def save_workspace(workspace_id: str, json_input, title: str, project_id: str):
    """Save a workspace from a JSON definition

    Appends a new version to an existing workspace, or creates a new workspace (version 1)
    if the id does not yet exist.

    Args:
        workspace_id: The ID for the workspace
        json_input: JSON file path or '-' for stdin
    """
    session = SessionLocal()
    try:
        # Parse JSON input
        try:
            data = json.load(json_input)
        except json.JSONDecodeError as e:
            click.echo(f"Error: Invalid JSON - {e}", err=True)
            sys.exit(1)

        # Extract fields
        workspace_title = title or data.get("title", "Untitled Workspace")
        layout = data.get("layout", {})

        # Check if workspace already exists
        existing = session.query(Workspace).filter(Workspace.id == workspace_id).first()

        if existing:
            # Append a new version (never overwrites prior layouts)
            existing.title = workspace_title
            next_version = max((v.version for v in existing.versions), default=0) + 1
            session.add(WorkspaceVersion(workspace_id=existing.id, version=next_version, layout=layout))
            click.echo(f"Added version {next_version} to workspace '{workspace_id}'")
        else:
            # Create new workspace with its version-1 layout
            ws = Workspace(
                id=workspace_id,
                title=workspace_title,
                project_id=project_id,
            )
            ws.versions.append(WorkspaceVersion(version=1, layout=layout))
            session.add(ws)
            click.echo(f"Created workspace '{workspace_id}'")

        session.commit()

    except Exception as e:
        session.rollback()
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    finally:
        session.close()


@workspace.command("list")
def list_workspaces():
    """List all workspaces"""
    session = SessionLocal()
    try:
        workspaces = session.query(Workspace).all()

        if not workspaces:
            click.echo("No workspaces found")
            return

        click.echo(f"{'ID':<20} {'Title':<30} {'Created':<20}")
        click.echo("-" * 70)

        for ws in workspaces:
            created = ws.created_at.strftime("%Y-%m-%d %H:%M:%S")
            click.echo(f"{ws.id:<20} {ws.title:<30} {created:<20}")

    finally:
        session.close()


@workspace.command("delete")
@click.argument("workspace_id")
@click.option("--force", is_flag=True, help="Skip confirmation prompt")
def delete_workspace(workspace_id: str, force: bool):
    """Delete a workspace

    Args:
        workspace_id: The ID of the workspace to delete
    """
    if workspace_id == "default":
        click.echo("Error: Cannot delete the default workspace", err=True)
        sys.exit(1)

    session = SessionLocal()
    try:
        ws = session.query(Workspace).filter(Workspace.id == workspace_id).first()

        if not ws:
            click.echo(f"Error: Workspace '{workspace_id}' not found", err=True)
            sys.exit(1)

        if not force:
            if not click.confirm(f"Delete workspace '{ws.title}' ({workspace_id})?"):
                click.echo("Cancelled")
                return

        session.delete(ws)
        session.commit()
        click.echo(f"Deleted workspace '{workspace_id}'")

    except Exception as e:
        session.rollback()
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    finally:
        session.close()


if __name__ == "__main__":
    cli()
