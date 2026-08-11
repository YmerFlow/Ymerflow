# Technology Stack

This document describes the technologies and libraries used throughout Nagelfluh.

For a complete list of open source packages with links, see **[Dependencies](dependencies.md)**.

## Frontend

### Core Framework
- **React 18** - UI framework with hooks and context for state management
- **Create React App** - Build tooling and development server
- **React Router DOM** - Client-side routing, including popout window support

### UI Components and Layout
- **React Bootstrap** - UI component library
- **react-dnd** - Drag-and-drop functionality for layout system
- **Custom Flexout System** - Proprietary layout engine with splits, tabs, and popouts

### Data Visualization
- **Plotly.js** via **react-plotly.js** - Scientific plotting and charting
- **ReactFlow** - Interactive node-based graph visualization for process flows
- **Leaflet** (via react-leaflet) - Map visualization (if used for MapView)

### Forms and Data Input
- **@rjsf/core** (React JSON Schema Form) - Dynamic form generation from JSON schemas
- **@rjsf/bootstrap-4** - Bootstrap theme for forms
- Custom form extensions:
  - `DatasetSelector` - Searchable dataset picker
  - `CustomStringField` - Format-based field detection

### State Management
- **React Context API** - Global state for processes, layout, and menus
- **Custom contexts**:
  - `ProcessContext` - Process management and active process
  - `LayoutContext` - Layout tree and widget management
  - `MenuContext` - Menu registration system

### Build and Development Tools
- **Webpack** (via CRA) - Module bundling
- **Babel** (via CRA) - JavaScript transpilation
- **ESLint** - Code linting
- **Prettier** - Code formatting
- **Jest** - Testing framework
- **React Testing Library** - Component testing utilities

## Backend

### Core Framework
- **FastAPI** - Modern Python web framework with automatic OpenAPI docs
- **Uvicorn** - ASGI server for running FastAPI
- **Python 3.11+** - Programming language

### Database
- **SQLAlchemy** - ORM for database operations
- **Alembic** - Database schema migrations
- **SQLite** - Development database
- **PostgreSQL** - Production database (recommended)

### Kubernetes Integration
- **kubernetes** (Python client) - Kubernetes API interaction
- **Kueue** - Job queuing and resource management (external)
- Job orchestration for process execution
- Pod log streaming and monitoring

### Storage
- **fsspec** - Unified filesystem interface
- **s3fs** - S3-compatible storage backend
- **gcsfs** - Google Cloud Storage backend
- **MinIO** - S3-compatible object storage (development)
- **GCS / S3** - Cloud object storage (production)

### Real-time Communication
- **WebSockets** (FastAPI native) - Real-time log streaming and state updates
- **asyncio** - Asynchronous I/O for concurrent operations

### API and Documentation
- **Pydantic** - Data validation and settings management
- **OpenAPI** - Automatic API documentation generation
- **Swagger UI** - Interactive API testing interface (built-in)
- **ReDoc** - Alternative API documentation UI (built-in)

### Security
- **python-jose** - JWT token handling
- **passlib** - Password hashing
- **bcrypt** - Secure password hashing algorithm

### Utilities
- **python-dotenv** - Environment variable management
- **requests** - HTTP client library

## Infrastructure

### Container Orchestration
- **Kubernetes** - Container orchestration platform
- **Minikube** - Local Kubernetes cluster for development
- **kubectl** - Kubernetes command-line tool
- **Kueue v0.9.1** - Job queuing system with resource quotas

### Containerization
- **Docker** - Container runtime and image building
- **Python 3.11-slim** base images - Lightweight Python containers
- Custom process runner containers with entrypoint discovery

### Object Storage
- **MinIO** - S3-compatible storage for development
  - Deployed in Minikube
  - MinIO Client (`mc`) for management
  - Per-project buckets with IAM policies
- **Google Cloud Storage (GCS)** - Production storage for GCP
  - Workload Identity for authentication
  - IAM conditions for path-based access control
- **AWS S3** - Production storage for AWS
  - IRSA (IAM Roles for Service Accounts) for authentication
  - IAM policies with resource-based permissions

### Cloud Platforms (Production)
- **Google Kubernetes Engine (GKE)** - Managed Kubernetes on GCP
- **Amazon Elastic Kubernetes Service (EKS)** - Managed Kubernetes on AWS
- **Google Cloud Storage (GCS)** - Object storage on GCP
- **AWS S3** - Object storage on AWS

### Monitoring and Logging (Future)
- **Prometheus** - Metrics collection (planned)
- **Grafana** - Metrics visualization (planned)
- **Fluentd / Fluent Bit** - Log aggregation (planned)

## Process Execution

### Process Type System
- **setuptools entrypoints** - Plugin-based process type registration
- **pkg_resources** - Entrypoint discovery and loading
- Custom process type framework with:
  - JSON Schema for parameter validation
  - `schema()` class method for configuration
  - `run()` class method for execution

### Data Formats
- **MessagePack** - Binary serialization for AEM data (via libaarhusxyz)
- **GeoJSON** - Geographic vector data
- **GeoTIFF** - Raster/grid data
- **CSV** - Tabular data export
- **JSON** - Configuration and metadata

### Scientific Computing (Process-Specific)
- **NumPy** - Numerical computing
- **SimPEG** - Geophysical inversions
- **libaarhusxyz** - AEM data handling
- Other domain-specific libraries installed per process type

## Development Tools

### Version Control
- **Git** - Source control
- **GitHub** - Code hosting and collaboration

### Package Management
- **pip** - Python package management
- **npm** - Node.js package management
- **requirements.txt** - Python dependency specification
- **package.json** - Node.js dependency specification

### Code Quality
- **Black** - Python code formatting
- **Flake8** - Python linting
- **mypy** - Python type checking
- **ESLint** - JavaScript linting
- **Prettier** - JavaScript formatting

### Testing
- **pytest** - Python testing framework (planned)
- **Jest** - JavaScript testing framework
- **React Testing Library** - React component testing

### Development Scripts
- Custom bash scripts in `dev/`:
  - `runall.sh` - Complete setup automation
  - `cleanup-all.sh` - Environment cleanup
- Minikube/MinIO/docker-v2-registry provisioning itself is no longer a dedicated script — it's
  `plugins/ymerflow-minikube`'s `bootstrap()` hooks, invoked by `backend/bin/yf-bootstrap-provision`
  (called from `runall.sh`) — see `docs/plans/minikube-provisioning-plugin.md`.

## Networking and Communication

### Protocols
- **HTTP/HTTPS** - API communication
- **WebSocket (WS/WSS)** - Real-time updates
- **S3 API** - Object storage protocol

### API Standards
- **REST** - RESTful API design
- **OpenAPI 3.0** - API specification
- **JSON Schema** - Data validation and form generation

## Security and Authentication

### Authentication
- **JWT (JSON Web Tokens)** - User session management
- **Bearer tokens** - API authentication

### Cloud IAM
- **MinIO IAM** - Path-based access control (development)
- **Google Cloud IAM** - GCS access control (production)
  - Workload Identity for pod authentication
  - Conditional role bindings
- **AWS IAM** - S3 access control (production)
  - IRSA for pod authentication
  - Resource-based policies

### Secrets Management
- **Kubernetes Secrets** - Credential storage and injection
- **Environment variables** - Configuration management
- **.env files** - Local development configuration

## Browser Support

### Minimum Requirements
- **Chrome/Edge**: Version 90+ (recommended)
- **Firefox**: Version 88+
- **Safari**: Version 14+

### Browser APIs Used
- **WebSocket API** - Real-time communication
- **Local Storage** - Layout persistence
- **Fetch API** - HTTP requests
- **Canvas API** - Plotting (via Plotly)

## Deployment

### Development
- **Minikube** - Local Kubernetes
- **MinIO** - Local object storage
- **SQLite** - Local database
- **Hot reload** - Backend (Uvicorn) and frontend (CRA)

### Production
- **GKE or EKS** - Managed Kubernetes
- **GCS or S3** - Cloud object storage
- **PostgreSQL** - Production database (Cloud SQL, RDS, etc.)
- **Nginx** - Static file serving for frontend
- **Load balancers** - Traffic distribution

## Version Requirements

### Minimum Versions
- **Python**: 3.11+
- **Node.js**: 16+
- **Kubernetes**: 1.24+
- **Docker**: 20.10+
- **Minikube**: 1.30+

### Recommended Versions
- **Python**: 3.11 (tested)
- **Node.js**: 18 LTS
- **Kubernetes**: 1.28+
- **Docker**: 24.0+

## License

All software components are either:
- Open source (see individual library licenses)
- Proprietary (Nagelfluh codebase - GPL v3.0)

Third-party licenses are respected per their respective terms.
