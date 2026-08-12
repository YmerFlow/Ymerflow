import time
import uuid
import json
import fsspec
import pandas as pd

class create_environment:
    """Create environment process type."""

    @classmethod
    def schema(cls):
        """Return JSON Schema for create_environment parameters."""
        return {
            "type": "object",
            "properties": {
                "environment_name": {
                    "type": "string",
                    "title": "Environment Name",
                    "description": "Name for the environment (will be slugified for Docker image)"
                },
                "base_image": {
                    "type": "string",
                    "title": "Base Docker Image",
                    "default": "python:3.11-slim",
                    "description": "Base Docker image to build from"
                },
                "python_packages": {
                    "type": "string",
                    "title": "Python Packages",
                    "description": "Python packages to install (requirements.txt format)",
                    "x-format": "textarea"
                },
                "dockerfile_instructions": {
                    "type": "string",
                    "title": "Additional Dockerfile Instructions",
                    "description": "Additional Dockerfile instructions to execute",
                    "x-format": "textarea"
                }
            },
            "required": ["environment_name", "base_image"]
        }

    @classmethod
    def run(cls, storage_context=None, **kwargs):
        """Create environment by building and pushing Docker image."""
        import os
        import re
        import subprocess
        import tarfile
        import tempfile

        print("Creating environment...")
        print(f"Parameters: {kwargs}")

        # Get parameters
        environment_name = kwargs.get('environment_name', 'unnamed-env')
        base_image = kwargs.get('base_image', 'python:3.11-slim')
        python_packages = kwargs.get('python_packages', '').strip()
        dockerfile_instructions = kwargs.get('dockerfile_instructions', '').strip()

        # Get context
        process_id = storage_context['process_id']
        project_id = storage_context['project_id']
        version = os.environ.get('VERSION', '1')
        registry_url = os.environ.get('REGISTRY_URL', '')
        registry_auth = os.environ.get('REGISTRY_AUTH', '')

        if not registry_url:
            raise ValueError("REGISTRY_URL environment variable not set")

        # Slugify environment name
        env_slug = re.sub(r'[^a-z0-9-]', '-', environment_name.lower()).strip('-')
        if not env_slug:
            env_slug = 'unnamed-env'

        # Build image tag: {registry_url}/proj-{project_id}/env-{slug}:{process_id}-{version}
        image_repository = f"{registry_url}/proj-{project_id}/env-{env_slug}"
        image_tag = f"{process_id}-{version}"
        full_image_name = f"{image_repository}:{image_tag}"

        print(f"Building image: {full_image_name}")

        # Construct Dockerfile
        # If base_image doesn't have a registry prefix, add the local registry
        if base_image and not base_image.startswith(('registry:', 'localhost:', 'gcr.io/', 'docker.io/')):
            # Check if it's a ymerflow base image and needs registry prefix
            if base_image.startswith('ymerflow-'):
                base_image_with_registry = f"{registry_url}/{base_image}"
            else:
                # External image from Docker Hub, use as-is
                base_image_with_registry = base_image
        else:
            base_image_with_registry = base_image

        dockerfile_content = f"FROM {base_image_with_registry}\n\n"

        # Add python packages if provided
        if python_packages:
            dockerfile_content += "# Install Python packages\n"
            dockerfile_content += "RUN pip install --no-cache-dir \\\n"
            for line in python_packages.split('\n'):
                line = line.strip()
                if line and not line.startswith('#'):
                    dockerfile_content += f"    {line} \\\n"
            # Remove trailing backslash and add newline
            dockerfile_content = dockerfile_content.rstrip(' \\\n') + '\n\n'

        # Add additional Dockerfile instructions if provided
        if dockerfile_instructions:
            dockerfile_content += "# Additional instructions\n"
            dockerfile_content += dockerfile_instructions + "\n"

        print("Dockerfile content:")
        print("---")
        print(dockerfile_content)
        print("---")

        # Create temporary directory for build context
        with tempfile.TemporaryDirectory() as tmpdir:
            # Write Dockerfile
            dockerfile_path = os.path.join(tmpdir, 'Dockerfile')
            with open(dockerfile_path, 'w') as f:
                f.write(dockerfile_content)

            # Prepare kaniko auth config if needed
            kaniko_args = [
                '/kaniko-executor',
                f'--context=dir://{tmpdir}',
                f'--dockerfile={dockerfile_path}',
                f'--destination={full_image_name}',
                '--insecure',  # For dev registry without TLS
                '--skip-tls-verify',  # For dev registry
                '--insecure-pull',  # Allow pulling from insecure registries
                f'--skip-tls-verify-registry={registry_url}',  # Skip TLS for pulling from our registry
            ]

            # Add auth if provided
            if registry_auth:
                # Create Docker config.json from auth
                docker_config_dir = os.path.join(tmpdir, '.docker')
                os.makedirs(docker_config_dir, exist_ok=True)

                config_content = {
                    "auths": {
                        registry_url: {
                            "auth": registry_auth
                        }
                    }
                }

                config_path = os.path.join(docker_config_dir, 'config.json')
                with open(config_path, 'w') as f:
                    json.dump(config_content, f)

                # Set DOCKER_CONFIG env var for kaniko and crane (crane also
                # reads DOCKER_CONFIG for registry auth)
                os.environ['DOCKER_CONFIG'] = docker_config_dir

            print(f"Running Kaniko to build and push image...")

            try:
                result = subprocess.run(
                    kaniko_args,
                    cwd=tmpdir,
                    capture_output=True,
                    text=True,
                    timeout=600  # 10 minute timeout
                )

                print("Kaniko stdout:")
                print(result.stdout)

                if result.returncode != 0:
                    print("Kaniko stderr:")
                    print(result.stderr)
                    raise RuntimeError(f"Kaniko build failed with exit code {result.returncode}")

                print(f"✓ Image built and pushed successfully: {full_image_name}")

            except subprocess.TimeoutExpired:
                raise RuntimeError("Kaniko build timed out after 10 minutes")

            # Extract process_schemas.json from the built image using crane.
            # This must run before tmpdir (and DOCKER_CONFIG, which points
            # inside it) is removed on exit from this `with` block, otherwise
            # crane loses its registry auth.
            print(f"Extracting process schemas from image...")

            tar_path = os.path.join(tmpdir, 'image.tar')
            crane_result = subprocess.run(
                ['crane', 'export', '--insecure', full_image_name, tar_path],
                capture_output=True,
                text=True,
                timeout=60
            )

            if crane_result.returncode != 0:
                raise RuntimeError(
                    f"crane export failed for {full_image_name} "
                    f"(exit {crane_result.returncode}): {crane_result.stderr.strip()}"
                )

            with tarfile.open(tar_path) as tar:
                try:
                    member = tar.getmember('app/process_schemas.json')
                except KeyError:
                    raise RuntimeError(
                        f"app/process_schemas.json not found in image {full_image_name}"
                    )
                with tar.extractfile(member) as f:
                    process_schemas = json.loads(f.read().decode('utf-8'))

            print(f"✓ Extracted process schemas: {list(process_schemas.keys())}")

        # Write environment info to storage (will be picked up by _create_outputs)
        print(f"Writing environment info to storage...")

        environment_info = {
            "name": environment_name,
            "docker_image": full_image_name,
            "process_id": process_id,
            "process_types": process_schemas
        }

        storage_base = storage_context['storage_base']
        storage_kwargs = storage_context['storage_kwargs']
        env_info_url = f"{storage_base}/processes/{process_id}/environment.json"

        print(f"Writing to: {env_info_url}")

        with fsspec.open(env_info_url, 'w', **storage_kwargs) as f:
            json.dump(environment_info, f, indent=2)

        print(f"✓ Environment info written to storage")

        print("Environment creation complete")
        return {
            "status": "success",
            "image": full_image_name,
            "environment_name": environment_name,
            "process_types": list(process_schemas.keys())
        }
