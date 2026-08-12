# Development Guide

This guide covers development workflows, testing, and contributing to YmerFlow.

## Development Environment

### Prerequisites

- Python 3.11+
- Node.js 16+
- Docker
- Minikube
- kubectl
- Git

### Initial Setup

Follow the [Deployment Guide](deployment.md) to set up your development environment.

**Quick start:**

```bash
./dev/runall.sh
```

## Project Structure

```
nagelfluh/
├── backend/                    # FastAPI backend (installed editable from root setup.py)
│   ├── main.py                # Main application
│   ├── models.py              # Database models
│   ├── config.py              # Configuration
│   └── alembic/               # Database migrations
├── frontend/                   # React frontend (Vite + Vitest)
│   ├── src/
│   │   ├── App.jsx             # Main app component (widget registration)
│   │   ├── ProcessContext.jsx  # Process state management
│   │   ├── datamodel/          # api.js (axios client), useQueries.js (TanStack Query hooks),
│   │   │                       #   dataset.js and friends
│   │   ├── widgets/             # Pluggable UI widgets, one dir/file per widget:
│   │   │   ├── FlowView/       # Process graph widget
│   │   │   ├── PlotView/       # Plotting widget (gladly-based)
│   │   │   ├── ProcessEditor.jsx
│   │   │   ├── ProcessLog.jsx
│   │   │   └── ...             # AEMModelSimulator/, EnvironmentView.jsx, etc.
│   │   ├── flexout/            # Layout system
│   │   ├── jsoneditor/         # JSON Schema forms
│   │   ├── plugins/            # Frontend plugin loading/hook registries
│   │   ├── clusterProviders/   # Per-cluster-type admin form components
│   │   ├── storageProviders/   # Per-storage-backend-type admin form components
│   │   └── AdminPage.jsx, AccountPage.jsx, AuthContext.jsx, ProjectMembersModal.jsx,
│   │       ProjectExportModal.jsx, ClustersAdminPanel.jsx, StorageBackendsAdminPanel.jsx,
│   │       WorkspaceSharingModal.jsx, WorkspaceMenu.jsx, InviteAcceptPage.jsx, ...
│   │       # Top-level account/admin/workspace-sharing/plugin-management features —
│   │       # see the relevant architecture/frontend docs, or read the source directly.
│   ├── public/
│   └── package.json
├── docker/                     # Docker images
│   └── base-runner/           # Process runner container
│       ├── Dockerfile
│       ├── runner.py          # Process execution script
│       └── nagelfluh_processes/  # Process type implementations
├── dev/                        # Development scripts
│   ├── runall.sh              # Complete setup script (Minikube/MinIO/registry provisioning
│   │                          #   itself now happens via plugins/ymerflow-minikube's bootstrap()
│   │                          #   hooks, called from this script — no dedicated setup-*.sh anymore)
│   └── cleanup-all.sh    # Cleanup script
├── docs/                       # Documentation
│   ├── architecture/          # Architecture docs
│   ├── frontend/              # Frontend docs
│   ├── deployment.md          # Deployment guide
│   └── development.md         # This file
└── CLAUDE.md                   # Instructions for Claude Code
```

## Backend Development

### Running the Backend

**Development mode with auto-reload:**

```bash
./backend/run.sh

# Or manually:
cd backend
uvicorn main:app --reload --port 8000
```

The server will automatically reload when you change Python files.

The backend is installed editable (`pip install -e .`, run by `dev/runall.sh`), so source edits are
picked up immediately by the reloader. **Exception:** changes to `setup.py`'s `entry_points` (e.g.
adding a `nagelfluh.models` or `nagelfluh.migration_dirs` registration) are read from installed
distribution metadata, not source — re-run `pip install -e .` for those to take effect.

### API Endpoints

Key endpoints (all project-resource endpoints live under `/projects/{project_id}/...` — the
`project_id` path segment accepts either a real project id (read/write, real membership required)
or a publication id (read-only; see `docs/plans/done/publication-readonly-projects.md`)):
- `GET /` - Health check
- `GET /process-types` - List available process types with schemas
- `POST /projects/{project_id}/process` - Create new process
- `GET /projects/{project_id}/processes` - List processes in a project
- `GET /projects/{project_id}/process/{id}` - Get process details
- `GET /projects/{project_id}/datasets` - Search datasets
- `GET /projects/{project_id}/dataset/{id}` - Get dataset content
- `WS /ws/logs` - WebSocket for log streaming
- `WS /ws/state` - WebSocket for state updates

**Interactive API docs:**
- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

### Database Migrations

YmerFlow uses Alembic for database schema management.

**Create a new migration:**

```bash
cd backend
alembic revision -m "description of changes"
```

This creates a new migration file in `backend/alembic/versions/`.

**Edit the migration:**

```python
# alembic/versions/xxx_description.py

def upgrade():
    op.create_table(
        'my_table',
        sa.Column('id', sa.String(), nullable=False),
        sa.Column('name', sa.String(), nullable=True),
        sa.PrimaryKeyConstraint('id')
    )

def downgrade():
    op.drop_table('my_table')
```

**Apply migrations:**

```bash
env/bin/python backend/bin/nagelfluh-migrate
```

**Rollback migration:**

```bash
alembic -c backend/alembic.ini downgrade -1
```

**View migration history:**

```bash
alembic -c backend/alembic.ini history
alembic -c backend/alembic.ini current
```

### Adding a New API Endpoint

```python
# backend/main.py

@app.get("/my-endpoint")
async def my_endpoint(param: str = Query(...)):
    """Endpoint description for API docs."""
    return {"result": f"Got param: {param}"}
```

FastAPI automatically generates OpenAPI documentation.

### Database Queries

```python
from sqlalchemy.orm import Session
from backend.models import Process, ProcessVersion

def get_user_processes(db: Session, user_id: str):
    return db.query(Process).filter(
        Process.user_id == user_id
    ).all()

# In endpoint:
@app.get("/user-processes")
async def user_processes(
    user_id: str,
    db: Session = Depends(get_db)
):
    processes = get_user_processes(db, user_id)
    return processes
```

### Testing Backend

Backend testing is minimal and ad hoc — there's no `pytest.ini`/`conftest.py`/pytest section in
`pyproject.toml`, and no test suite covering the API or models. What exists is a handful of
standalone smoke-test scripts alongside the code they check, e.g.
`backend/test_log_manager_integration.py` (`test_log_manager_smoke()` — verifies `LogManager`
imports, instantiates, and its dedup/checkpoint logic behaves, without hitting a real database).

```bash
cd backend

# Run a smoke test directly
python test_log_manager_integration.py

# Or under pytest (works even without a pytest config file)
pytest test_log_manager_integration.py -v
```

If you add real backend tests, prefer wiring up a proper pytest config (`pytest.ini` or a
`[tool.pytest.ini_options]` section) rather than continuing the standalone-script pattern.

## Frontend Development

### Running the Frontend

```bash
cd frontend
npm start
```

Development server runs on http://localhost:3000 with hot reload.

### Code Structure

- **Components**: React components in `src/`
- **Contexts**: Global state management (ProcessContext, LayoutContext)
- **Widgets**: Pluggable UI components (FlowView, ProcessEditor, etc.)
- **Flexout**: Layout system in `src/flexout/`
- **JSON Editor**: Form system in `src/jsoneditor/`

### Adding a New Widget

See [Widget System](frontend/widgets.md) for details.

**Quick example:**

```javascript
// src/MyWidget.js
import React from 'react';
import { useProcessContext } from './ProcessContext';

function MyWidget() {
  const { processes, activeProcess } = useProcessContext();

  return (
    <div style={{ padding: '10px' }}>
      <h3>My Widget</h3>
      <p>Active: {activeProcess?.processId || 'None'}</p>
    </div>
  );
}

MyWidget.title = "My Widget";
export default MyWidget;
```

**Register in App.js:**

```javascript
import MyWidget from './MyWidget';

const widgets = {
  FlowView,
  ProcessEditor,
  // ... other widgets
  MyWidget,
};
```

### State Management

**ProcessContext** - Global process state:

```javascript
import { useProcessContext } from './ProcessContext';

const {
  processes,           // All processes
  activeProcess,       // Currently selected process
  setActiveProcess,    // Set active process
  createProcess,       // Create new process
  updateProcess,       // Update process parameters
} = useProcessContext();
```

**LayoutContext** - Layout management:

```javascript
import { useLayoutContext } from './flexout/LayoutContext';

const {
  layout,              // Layout tree
  widgets,             // Available widgets
  updateNode,          // Update layout node
  splitNode,           // Create split
} = useLayoutContext();
```

### API Calls

**Do not write manual `fetch()` calls or ad hoc API objects.** Data fetching goes through
TanStack Query hooks in `frontend/src/datamodel/useQueries.js` (e.g. `useProcesses`,
`useSearchDatasets`, `useCreateProcess`), and all cache invalidation goes through the
`ProcessContext` helpers (`invalidateProcess`, `invalidateProject`, `invalidateDatasets`) —
never `queryClient.invalidateQueries()` directly. This is a hard rule; see CLAUDE.md's Data
Access Patterns section.

Underneath those hooks, the actual HTTP client lives in `frontend/src/datamodel/api.js`: an
axios instance plus one exported async function per endpoint (`getProcesses`, `createProcess`,
`getDataset`, `searchDatasets`, ...), along with `API`/`ABSOLUTE_API`/`WS_API` (base URLs derived
from `VITE_API_URL`) and `setAuthToken()`. You should rarely need to touch `api.js` directly —
add a new exported function there only when adding a new hook in `useQueries.js` that needs it.

See [Query Architecture](frontend/queries.md) for the complete hook/invalidation pattern.

### Testing Frontend

The frontend uses [Vitest](https://vitest.dev/) (`npm test` runs `vitest`), not Jest/CRA. There
are currently no `*.test.*` files anywhere under `frontend/src` — the test suite is empty. Unlike
Jest, Vitest watches by default when run interactively in a terminal; `npm test` alone drops you
into watch mode.

```bash
cd frontend

# Run in watch mode (default interactive behavior)
npm test

# Run once and exit (e.g. for CI)
npm test -- --run

# Run with coverage
npm test -- --coverage

# Run a specific test file, once it exists
npm test -- MyWidget.test.jsx
```

When adding the first tests for a widget, follow Vitest's own conventions (`import { describe,
it, expect } from 'vitest'`) and place the file next to the component it covers (e.g.
`frontend/src/widgets/MyWidget.test.jsx`). `@testing-library/react` is not currently a
dependency — if you want component-rendering tests, add it (`npm install --save-dev
@testing-library/react`, with the user's approval per CLAUDE.md's package-installation rule)
rather than assuming it's already available.

### Linting

```bash
cd frontend

# Run ESLint
npm run lint

# Fix auto-fixable issues
npm run lint -- --fix
```

### Building for Production

```bash
cd frontend

# Create production build
npm run build

# Test production build locally
npx serve -s build
```

Build output goes to `frontend/build/`.

## Docker Development

### Building Process Runner Image

```bash
./docker/build.sh
```

This builds `nagelfluh-base-runner:latest` in Minikube's Docker daemon.

### Testing Runner Locally

```bash
# Get Minikube IP
MINIKUBE_IP=$(minikube ip)

# Run container locally
docker run --rm \
  -e PROCESS_TYPE=fft \
  -e PROCESS_ID=test-123 \
  -e VERSION=1 \
  -e PROJECT_ID=test-project \
  -e PARAMETERS_JSON='{"input_data":"http://example.com/dataset/123"}' \
  -e BACKEND_URL=http://host.docker.internal:8000 \
  -e STORAGE_BASE=s3://nagelfluh-test \
  -e STORAGE_ENDPOINT=http://host.docker.internal:9000 \
  ${MINIKUBE_IP}:30500/nagelfluh-base-runner:latest
```

### Adding Process Types

See [Process Development](architecture/processes.md) for details.

**Quick example:**

```python
# docker/base-runner/nagelfluh_processes/my_processes.py

class my_process:
    """My custom process."""

    @classmethod
    def schema(cls):
        return {
            "type": "object",
            "properties": {
                "input": {
                    "type": "string",
                    "format": "uri",
                    "x-format": "dataset",
                    "title": "Input"
                },
                "param": {
                    "type": "number",
                    "default": 1.0,
                    "title": "Parameter"
                }
            }
        }

    @classmethod
    def run(cls, storage_context=None, **kwargs):
        print(f"Running with {kwargs}")
        # ... implementation ...
        return {"status": "success"}
```

**Register in setup.py:**

```python
# docker/base-runner/nagelfluh_processes/setup.py

setup(
    name="nagelfluh_processes",
    entry_points={
        "nagelfluh.process_types": [
            "fft=nagelfluh_processes.fake_processes:fft",
            "my_process=nagelfluh_processes.my_processes:my_process",
        ],
    },
)
```

**Rebuild image:**

```bash
./docker/build.sh
```

## Configuration

### Environment Variables

Create `.env` file in project root:

```bash
# Database
DATABASE_URL=sqlite:///./backend/nagelfluh.db

# Storage (Development - MinIO)
STORAGE_PROTOCOL=s3
STORAGE_ENDPOINT=http://localhost:9000
STORAGE_BUCKET_PREFIX=nagelfluh-project-

# Storage (Production - GCS)
# STORAGE_PROTOCOL=gcs
# STORAGE_ENDPOINT=
# STORAGE_BUCKET_PREFIX=nagelfluh-project-

# Kubernetes
K8S_NAMESPACE=nagelfluh-jobs

# Authentication
JWT_SECRET_KEY=your-secret-key-here-change-in-production

# GCP (if using GCS)
# GCP_PROJECT=your-gcp-project
```

### Backend Configuration

`backend/config.py` defines a `pydantic_settings.BaseSettings` subclass, `Settings`, with typed
fields and defaults; it's read from `config.env` (via `Config.env_file`) and instantiated once as
the module-level `settings` object:

```python
from pydantic_settings import BaseSettings
from typing import List, Optional

class Settings(BaseSettings):
    database_url: str = "sqlite:///./nagelfluh.db"

    # Per-project storage — seed-only; see the comment in config.py for why runtime code
    # doesn't read these directly anymore (routing goes through each project's StorageBackend row)
    storage_protocol: str = "s3"
    storage_endpoint: str = "https://localhost:9000"
    storage_bucket_prefix: str = "nagelfluh-project-"
    storage_tls_skip_verify: bool = False

    jwt_secret_key: Optional[str] = None   # None => generated at startup, warns in logs
    jwt_algorithm: str = "HS256"
    access_token_expire_days: int = 30

    cors_origins: List[str] = ["http://localhost:3000"]
    backend_base_url: str = "http://localhost:8000"
    frontend_base_url: str = "http://localhost:3000"

    # ... plus SMTP, container registry, and plugin-npm-build settings — see config.py directly.

    class Config:
        env_file = "config.env"
        env_file_encoding = "utf-8"
        extra = "ignore"

settings = Settings()
```

Import `settings` from `backend.config` and use `settings.database_url`, etc. — don't call
`os.getenv()` directly in application code.

**Note:** `process_cost` and `initial_user_balance` still exist as fields on `Settings`, but
billing has moved to a plugin — treat them as legacy/vestigial rather than active config unless
you've confirmed something still reads them.

### Frontend Configuration

API endpoint is configured in `frontend/src/datamodel/api.js`:

```javascript
export const API = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
```

Override with environment variable:

```bash
VITE_API_URL=https://api.nagelfluh.example.com npm start
```

## Git Workflow

### Branching Strategy

- `main` - Production-ready code
- `develop` - Development branch
- `feature/feature-name` - Feature branches
- `bugfix/bug-name` - Bug fix branches

### Commit Messages

Follow conventional commits:

```
feat: Add new plot element for resistivity data
fix: Correct dataset URL encoding in ProcessEditor
docs: Update architecture documentation
refactor: Simplify layout tree traversal
test: Add tests for dataset grouping
```

### Pull Requests

1. Create feature branch from `develop`
2. Make changes and commit
3. Push and create pull request
4. Request review
5. Address feedback
6. Merge to `develop`

## Code Style

### Python (Backend)

Follow PEP 8:

```bash
# Format with black
black backend/

# Lint with flake8
flake8 backend/

# Type checking with mypy
mypy backend/
```

### JavaScript (Frontend)

Follow Airbnb style guide:

```bash
# Lint
npm run lint

# Format with Prettier
npx prettier --write src/
```

## Debugging

### Backend Debugging

**Add print statements:**

```python
print(f"DEBUG: Process ID: {process_id}")
print(f"DEBUG: Parameters: {parameters}")
```

Logs appear in terminal where `./backend/run.sh` is running.

**Use debugger:**

```python
import pdb; pdb.set_trace()
```

**VS Code launch.json:**

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "FastAPI",
      "type": "python",
      "request": "launch",
      "module": "uvicorn",
      "args": ["backend.main:app", "--reload"],
      "jinja": true
    }
  ]
}
```

### Frontend Debugging

**Browser DevTools:**
- Console: `console.log()` statements
- Network: Inspect API calls
- React DevTools: Component tree and props

**Add breakpoints:**

```javascript
debugger;  // Execution pauses here in DevTools
```

**React DevTools:**

Install browser extension for React debugging:
- Chrome: React Developer Tools
- Firefox: React Developer Tools

### Kubernetes Debugging

**Check pod status:**

```bash
kubectl get pods -n nagelfluh-jobs
kubectl describe pod <pod-name> -n nagelfluh-jobs
```

**View pod logs:**

```bash
kubectl logs <pod-name> -n nagelfluh-jobs
kubectl logs -f <pod-name> -n nagelfluh-jobs  # Follow logs
```

**Execute in pod:**

```bash
kubectl exec -it <pod-name> -n nagelfluh-jobs -- /bin/bash
```

**Check events:**

```bash
kubectl get events -n nagelfluh-jobs --sort-by='.lastTimestamp'
```

### Storage Debugging

**Check MinIO status:**

```bash
# Check if MinIO is running
kubectl get pods -n minio

# View MinIO logs
kubectl logs -n minio -l app=minio

# Test mc connection
mc admin info myminio
```

**Manage buckets:**

```bash
# List all buckets
mc ls myminio/

# List bucket contents
mc ls myminio/nagelfluh-project-{project-id}/

# Tree view of bucket
mc tree myminio/nagelfluh-project-{project-id}/
```

**Manage users and policies:**

```bash
# List all users
mc admin user list myminio

# Check user details
mc admin user info myminio project-{project-id}

# List policies
mc admin policy list myminio

# Check policy details
mc admin policy info myminio project-{project-id}-policy

# Show which users have a policy
mc admin policy entities myminio project-{project-id}-policy
```

**Check Kubernetes secrets:**

```bash
# List storage secrets
kubectl get secrets -n nagelfluh-jobs | grep storage

# View secret contents
kubectl get secret project-{project-id}-storage -n nagelfluh-jobs -o yaml

# Decode credentials
kubectl get secret project-{project-id}-storage -n nagelfluh-jobs -o json | \
  jq -r '.data["access-key"]' | base64 -d
```

**Test storage access from pod:**

```bash
kubectl exec -it <pod-name> -n nagelfluh-jobs -- python3 -c "
import fsspec, os
fs = fsspec.filesystem('s3',
    key=os.environ['AWS_ACCESS_KEY_ID'],
    secret=os.environ['AWS_SECRET_ACCESS_KEY'],
    client_kwargs={'endpoint_url': os.environ.get('STORAGE_ENDPOINT')})
print(fs.ls('nagelfluh-project-{project-id}'))
"
```

**MinIO not reachable on localhost:9000:**

MinIO is a NodePort (30900), published on the host by minikube's docker driver — not a
port-forward. Check the mapping:

```bash
docker port minikube | grep 30900
kubectl get pods -n minio -l app=minio
```

If the host port isn't published, re-run `PYTHONPATH=. env/bin/python
backend/bin/nagelfluh-bootstrap-provision` — `plugins/ymerflow-minikube`'s
`MinikubeClusterProvider.bootstrap()` detects the missing publish and recreates minikube.

## Performance Optimization

### Backend

- **Database indexing**: Add indexes to frequently queried columns
- **Query optimization**: Use `select_related()` and `prefetch_related()`
- **Caching**: Use Redis for frequently accessed data
- **Async operations**: Use `async`/`await` for I/O operations

### Frontend

- **Code splitting**: Use `React.lazy()` for large components
- **Memoization**: Use `useMemo()` and `useCallback()`
- **Virtual scrolling**: For large lists (react-window)
- **Debouncing**: Debounce search and resize handlers

## Contributing

### Before Contributing

1. Check existing issues or create a new one
2. Discuss approach before major changes
3. Follow code style guidelines
4. Add tests for new features
5. Update documentation

### Development Checklist

- [ ] Code follows style guidelines
- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] No console errors
- [ ] Git commit messages are clear
- [ ] Changes tested locally

### Getting Help

- Check [Architecture Documentation](architecture/overview.md)
- Review existing code for patterns
- Ask in GitHub issues
- Refer to CLAUDE.md for AI assistance guidelines

## License

YmerFlow is licensed under the GNU General Public License v3.0. See LICENSE file for details.
