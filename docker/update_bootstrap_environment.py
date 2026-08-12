#!/usr/bin/env python3
"""
Update an environment's process_types in the database.

This script is called by docker/build.sh after building the base-runner image
to populate an environment with discovered process types.

Usage:
    python docker/update_bootstrap_environment.py <process_schemas_json> [environment_name] [docker_image]

Arguments:
    process_schemas_json: JSON string or path to JSON file with process schemas
    environment_name: Name of the environment (defaults to "Bootstrap")
    docker_image: Docker image reference (defaults to "ymerflow-runner:latest")
"""

import sys
import json
import os
import uuid
from datetime import datetime
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker


def get_database_url():
    """Get database URL from environment variable or use default. Strips "+asyncpg" the same way
    backend/alembic/env.py and yf-build-and-push's get_database_url() do: this script
    always opens a synchronous engine, but DATABASE_URL (e.g. from ymerflow-backend-secret's
    envFrom, per docker/build.sh's production-mode db-update Job) is the async URL the FastAPI
    app itself needs."""
    return os.getenv('DATABASE_URL', 'sqlite:///./ymerflow.db').replace(
        "postgresql+asyncpg://", "postgresql://")


def update_bootstrap_environment(process_types, env_name="Bootstrap", docker_image="ymerflow-runner:latest"):
    """Update or create an environment with process types."""
    database_url = get_database_url()

    # Create synchronous engine (not async)
    engine = create_engine(database_url, echo=False)
    Session = sessionmaker(bind=engine)

    with Session() as session:
        # Find environment by name
        result = session.execute(
            text("SELECT id, name, docker_image FROM environments WHERE name = :name"),
            {"name": env_name}
        )
        row = result.fetchone()

        if row:
            # Update existing environment
            env_id = row[0]
            print(f"Updating existing environment: {env_id} ({row[1]})")
            session.execute(
                text("""
                    UPDATE environments
                    SET process_types = :process_types,
                        docker_image = :docker_image
                    WHERE id = :id
                """),
                {
                    "id": env_id,
                    "process_types": json.dumps(process_types),
                    "docker_image": docker_image
                }
            )
        else:
            # Create new environment
            env_id = str(uuid.uuid4())
            created_at = datetime.utcnow().isoformat()
            print(f"Creating new environment: {env_id} ({env_name})")
            session.execute(
                text("""
                    INSERT INTO environments (id, name, docker_image, process_types, process_id, created_at)
                    VALUES (:id, :name, :docker_image, :process_types, NULL, :created_at)
                """),
                {
                    "id": env_id,
                    "name": env_name,
                    "docker_image": docker_image,
                    "process_types": json.dumps(process_types),
                    "created_at": created_at
                }
            )

        session.commit()

        # Verify the update
        result = session.execute(
            text("SELECT id, name, docker_image, process_types FROM environments WHERE name = :name"),
            {"name": env_name}
        )
        row = result.fetchone()

        if row:
            stored_types = row[3] if isinstance(row[3], dict) else (json.loads(row[3]) if row[3] else {})
            print(f"✓ Environment updated successfully")
            print(f"  ID: {row[0]}")
            print(f"  Name: {row[1]}")
            print(f"  Image: {row[2]}")
            print(f"  Process types: {list(stored_types.keys())}")
        else:
            print("✗ Failed to update environment")
            sys.exit(1)


def main():
    if len(sys.argv) < 2:
        print("Usage: python docker/update_bootstrap_environment.py <process_schemas_json> [environment_name] [docker_image]")
        print("  process_schemas_json: JSON string or path to JSON file")
        print("  environment_name: Name of the environment (defaults to 'Bootstrap')")
        print("  docker_image: Docker image reference (defaults to 'ymerflow-runner:latest')")
        sys.exit(1)

    process_schemas_arg = sys.argv[1]
    env_name = sys.argv[2] if len(sys.argv) > 2 else "Bootstrap"
    docker_image = sys.argv[3] if len(sys.argv) > 3 else "ymerflow-runner:latest"

    # Try to parse as JSON string first, then try as file path
    try:
        process_types = json.loads(process_schemas_arg)
    except json.JSONDecodeError:
        # Try reading as file path
        try:
            with open(process_schemas_arg, 'r') as f:
                process_types = json.load(f)
        except Exception as e:
            print(f"Error: Could not parse argument as JSON or read as file: {e}")
            sys.exit(1)

    print(f"Updating {env_name} environment with {len(process_types)} process type(s)...")
    update_bootstrap_environment(process_types, env_name, docker_image)


if __name__ == "__main__":
    main()
