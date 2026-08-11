# Development Guide

This guide covers development workflows, testing, and contributing to Nagelfluh.

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
├── frontend/                   # React frontend
│   ├── src/
│   │   ├── App.js             # Main app component
│   │   ├── ProcessContext.js  # Process state management
│   │   ├── FlowView.js        # Process graph widget
│   │   ├── ProcessEditor.js   # Process editor widget
│   │   ├── ProcessLog.js      # Log viewer widget
│   │   ├── PlotView.js        # Plotting widget
│   │   ├── MapView.js         # Map widget
│   │   ├── flexout/           # Layout system
│   │   └── jsoneditor/        # JSON Schema forms
│   ├── public/
│   └── package.json
├── docker/                     # Docker images
│   └── base-runner/           # Process runner container
│       ├── Dockerfile
│       ├── runner.py          # Process execution script
│       └── ymerflow_processes/  # Process type implementations
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

Key endpoints:
- `GET /` - Health check
- `GET /process-types` - List available process types with schemas
- `POST /process` - Create new process
- `GET /processes` - List all processes
- `GET /process/{id}` - Get process details
- `GET /datasets` - Search datasets
- `GET /dataset/{id}` - Get dataset content
- `WS /ws/logs` - WebSocket for log streaming
- `WS /ws/state` - WebSocket for state updates

**Interactive API docs:**
- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

### Database Migrations

Nagelfluh uses Alembic for database schema management.

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
env/bin/python backend/bin/yf-migrate
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

```bash
cd backend

# Run tests (TODO: Add tests)
pytest

# Run with coverage
pytest --cov=backend tests/

# Run specific test
pytest tests/test_processes.py::test_create_process
```

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

Centralized in `src/api.js`:

```javascript
// api.js
export const api = {
  baseUrl: 'http://localhost:8000',

  async fetchProcessTypes() {
    const response = await fetch(`${this.baseUrl}/process-types`);
    return response.json();
  },

  async createProcess(type, parameters, resources) {
    const response = await fetch(`${this.baseUrl}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, parameters, resources })
    });
    return response.json();
  },
};
```

### Testing Frontend

```bash
cd frontend

# Run tests
npm test

# Run tests in watch mode
npm test -- --watch

# Run tests with coverage
npm test -- --coverage

# Run specific test file
npm test MyWidget.test.js
```

**Example test:**

```javascript
// MyWidget.test.js
import { render, screen } from '@testing-library/react';
import MyWidget from './MyWidget';
import { ProcessProvider } from './ProcessContext';

test('renders widget title', () => {
  render(
    <ProcessProvider>
      <MyWidget />
    </ProcessProvider>
  );
  expect(screen.getByText(/My Widget/i)).toBeInTheDocument();
});
```

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
# docker/base-runner/ymerflow_processes/my_processes.py

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
# docker/base-runner/ymerflow_processes/setup.py

setup(
    name="ymerflow_processes",
    entry_points={
        "nagelfluh.process_types": [
            "fft=ymerflow_processes.fake_processes:fft",
            "my_process=ymerflow_processes.my_processes:my_process",
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

Edit `backend/config.py`:

```python
import os

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./nagelfluh.db")
STORAGE_PROTOCOL = os.getenv("STORAGE_PROTOCOL", "s3")
STORAGE_ENDPOINT = os.getenv("STORAGE_ENDPOINT", "")
STORAGE_BUCKET_PREFIX = os.getenv("STORAGE_BUCKET_PREFIX", "nagelfluh-project-")
K8S_NAMESPACE = os.getenv("K8S_NAMESPACE", "nagelfluh-jobs")
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "dev-secret-key")
```

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
backend/bin/yf-bootstrap-provision` — `plugins/ymerflow-minikube`'s
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

Nagelfluh is licensed under the GNU General Public License v3.0. See LICENSE file for details.
