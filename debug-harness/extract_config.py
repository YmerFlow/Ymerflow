#!/usr/bin/env python3
"""Extract process configuration from database and create config.json."""

import sys
import json
import os
from pathlib import Path

# Add project root to path so we can import backend
project_root = Path(__file__).parent.parent.resolve()
sys.path.insert(0, str(project_root))

# Load .env file if it exists
env_file = project_root / '.env'
if env_file.exists():
    print(f"Loading environment from {env_file}")
    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                # Only set if not already in environment
                if key not in os.environ:
                    os.environ[key] = value
    print()

def main():
    import argparse
    parser = argparse.ArgumentParser(
        description='Extract process configuration from database'
    )
    parser.add_argument(
        'process_id',
        help='Process ID (e.g., e90107f9-9b4c-46c8-bbc7-b1ea713f5528)'
    )
    parser.add_argument(
        '--version',
        type=int,
        default=None,
        help='Process version (default: latest version)'
    )
    parser.add_argument(
        '--output',
        '-o',
        default='config.json',
        help='Output file path (default: config.json)'
    )
    args = parser.parse_args()

    try:
        # Import after backend is in path
        from sqlalchemy import create_engine, select, text
        from sqlalchemy.orm import sessionmaker
        from backend.database import Base
        from backend.models.process import Process, ProcessVersion
        from backend.config import settings

        # Connect to database
        # Try multiple possible locations
        default_db_path = None
        for possible_path in ['ymerflow.db', 'backend/ymerflow.db', 'nagelfluh.db', 'backend/nagelfluh.db']:
            full_path = project_root / possible_path
            if full_path.exists():
                default_db_path = str(full_path)
                break

        if not default_db_path:
            default_db_path = str(project_root / 'backend/ymerflow.db')

        db_url = os.environ.get('DATABASE_URL', f'sqlite:///{default_db_path}')

        # Ensure absolute path for sqlite
        if db_url.startswith('sqlite:///'):
            path = db_url[10:]  # Remove 'sqlite:///'
            if not path.startswith('/'):
                # Relative path - make it absolute from project root
                if path.startswith('./'):
                    path = path[2:]
                path = str(project_root / path)
                db_url = f'sqlite:///{path}'

        print(f"Connecting to database: {db_url}")
        engine = create_engine(db_url)
        Session = sessionmaker(bind=engine)
        session = Session()

        # Query process and version
        print(f"Querying process: {args.process_id}")

        if args.version:
            result = session.execute(
                text('''
                    SELECT p.id, p.type, p.project_id, p.environment_id,
                           pv.version, pv.parameters, e.docker_image
                    FROM processes p
                    JOIN process_versions pv ON p.id = pv.process_id
                    JOIN environments e ON p.environment_id = e.id
                    WHERE p.id = :process_id AND pv.version = :version
                '''),
                {'process_id': args.process_id, 'version': args.version}
            )
        else:
            result = session.execute(
                text('''
                    SELECT p.id, p.type, p.project_id, p.environment_id,
                           pv.version, pv.parameters, e.docker_image
                    FROM processes p
                    JOIN process_versions pv ON p.id = pv.process_id
                    JOIN environments e ON p.environment_id = e.id
                    WHERE p.id = :process_id
                    ORDER BY pv.version DESC
                    LIMIT 1
                '''),
                {'process_id': args.process_id}
            )

        row = result.fetchone()
        if not row:
            print(f"Error: Process {args.process_id} not found", file=sys.stderr)
            if args.version:
                print(f"  (version {args.version})", file=sys.stderr)
            sys.exit(1)

        process_id, process_type, project_id, environment_id, version, parameters_json, docker_image = row
        parameters = json.loads(parameters_json)

        print(f"Found process:")
        print(f"  Type: {process_type}")
        print(f"  Version: {version}")
        print(f"  Project ID: {project_id}")
        print(f"  Docker Image: {docker_image}")

        # Get storage configuration from settings or environment
        storage_base = os.environ.get('STORAGE_BASE')
        if not storage_base:
            # Try to construct from settings
            try:
                from backend.services.storage_service import get_storage_base_url
                storage_base = get_storage_base_url(project_id)
            except Exception as e:
                print(f"Warning: Could not determine storage_base: {e}")
                storage_base = f"s3://YOUR_BUCKET/projects/{project_id}"

        storage_endpoint = os.environ.get('STORAGE_ENDPOINT', 'http://localhost:9000')

        # Get AWS credentials from environment (try multiple sources)
        # 1. AWS_ACCESS_KEY_ID (standard AWS env var)
        # 2. MINIO_ROOT_USER (local dev MinIO)
        # 3. Fall back to placeholder
        aws_access_key = os.environ.get('AWS_ACCESS_KEY_ID')
        aws_secret_key = os.environ.get('AWS_SECRET_ACCESS_KEY')

        if not aws_access_key:
            # Try MinIO root credentials for local dev
            aws_access_key = os.environ.get('MINIO_ROOT_USER', 'YOUR_ACCESS_KEY')
            aws_secret_key = os.environ.get('MINIO_ROOT_PASSWORD', 'YOUR_SECRET_KEY')
            if aws_access_key != 'YOUR_ACCESS_KEY':
                print(f"Note: Using MINIO_ROOT_USER credentials from .env")

        # Create config
        config = {
            "process_type": process_type,
            "process_id": process_id,
            "version": str(version),
            "project_id": project_id,
            "docker_image": docker_image,
            "storage_base": storage_base,
            "storage_endpoint": storage_endpoint,
            "aws_access_key_id": aws_access_key,
            "aws_secret_access_key": aws_secret_key,
            "parameters": parameters
        }

        # Write config file
        output_path = Path(args.output)
        with open(output_path, 'w') as f:
            json.dump(config, f, indent=2)

        print(f"\nConfiguration written to: {output_path}")

        # Check if credentials were loaded
        if config['aws_access_key_id'] == 'YOUR_ACCESS_KEY':
            print("\n⚠️  WARNING: AWS credentials not found!")
            print("Please add one of the following to your .env file:")
            print("  - AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY")
            print("  - Or MINIO_ROOT_USER and MINIO_ROOT_PASSWORD")
        else:
            print(f"\n✓ Credentials loaded from .env (using {aws_access_key[:8]}...)")

        print("\nReview the configuration if needed, then run:")
        print(f"  cd {Path(__file__).parent.name}")
        print(f"  ./run_debug.sh")

    except ImportError as e:
        print(f"Error importing backend modules: {e}", file=sys.stderr)
        print("\nMake sure you're running this from the project root:", file=sys.stderr)
        print(f"  cd {project_root}", file=sys.stderr)
        print(f"  python debug-harness/extract_config.py {args.process_id}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == '__main__':
    main()
