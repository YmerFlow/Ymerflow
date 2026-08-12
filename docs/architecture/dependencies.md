# Open Source Dependencies

All major open source packages used in YmerFlow, organized by layer.

## Frontend (npm)

### Core Framework
| Package | Purpose |
|---------|---------|
| [react](https://react.dev) | UI framework |
| [react-dom](https://react.dev) | React DOM renderer |
| [react-router-dom](https://reactrouter.com) | Client-side routing and popout window support |
| [vite](https://vitejs.dev) | Build tooling and dev server |
| [react-scripts](https://create-react-app.dev) | Build tooling (Create React App); still a dependency but no longer used by any npm script — vestigial from before the Vite migration |

### Data Fetching & State
| Package | Purpose |
|---------|---------|
| [@tanstack/react-query](https://tanstack.com/query) | Server state management and caching |
| [axios](https://axios-http.com) | HTTP client |

### UI Components
| Package | Purpose |
|---------|---------|
| [react-bootstrap](https://react-bootstrap.netlify.app) | Bootstrap component wrappers |
| [bootstrap](https://getbootstrap.com) | CSS framework |
| [@fortawesome/fontawesome-free](https://fontawesome.com) | Icon library |
| [sass](https://sass-lang.com) | CSS preprocessor |

### Forms
| Package | Purpose |
|---------|---------|
| [@rjsf/core](https://rjsf-team.github.io/react-jsonschema-form) | Dynamic form generation from JSON Schema |
| [@rjsf/validator-ajv8](https://rjsf-team.github.io/react-jsonschema-form) | AJV8-based validator for RJSF |

### Layout & Drag-and-Drop
| Package | Purpose |
|---------|---------|
| [react-dnd](https://react-dnd.github.io/react-dnd) | Drag-and-drop primitives |
| [react-dnd-html5-backend](https://react-dnd.github.io/react-dnd) | HTML5 drag-and-drop backend |

### Plugin System
| Package | Purpose |
|---------|---------|
| [@module-federation/runtime](https://module-federation.io) | Runtime loading of independently-built/published frontend plugins |
| [@module-federation/vite](https://module-federation.io) | Vite integration for Module Federation (build-time) |

### Visualization
| Package | Purpose |
|---------|---------|
| [gladly-plot](https://www.npmjs.com/package/gladly-plot) | WebGL-based scientific plotting (primary plot library) |
| [regl](https://github.com/regl-project/regl) | WebGL abstraction (used by gladly-plot and custom layers) |
| [d3](https://d3js.org) | Data utilities and scales |
| [reactflow](https://reactflow.dev) | Interactive node graph for process flow view |
| [leaflet](https://leafletjs.com) | Slippy map (tile layers) |
| [react-leaflet](https://react-leaflet.js.org) | React bindings for Leaflet |

### Geo / Projection
| Package | Purpose |
|---------|---------|
| [proj4](https://github.com/proj4js/proj4js) | Coordinate reference system transformations |
| [projnames](https://www.npmjs.com/package/projnames) | EPSG code → proj4 string lookup |

### Data Formats
| Package | Purpose |
|---------|---------|
| [geotiff](https://geotiffjs.github.io) | GeoTIFF raster reading |
| [msgpack-lite](https://github.com/kawanet/msgpack-lite) | MessagePack serialization |
| [msgpack-numpy-js](https://www.npmjs.com/package/msgpack-numpy-js) | NumPy array decode extension for msgpack |
| [webxtile](https://www.npmjs.com/package/webxtile) | Tiled xarray/CF data loader (browser client) |

### Utilities
| Package | Purpose |
|---------|---------|
| [uuid](https://github.com/uuidjs/uuid) | UUID generation |
| [markdown-to-jsx](https://github.com/quantizor/markdown-to-jsx) | Markdown rendering to React elements |

---

## Backend (Python / pip)

### Web Framework
| Package | Purpose |
|---------|---------|
| [fastapi](https://fastapi.tiangolo.com) | Async REST + WebSocket framework with auto OpenAPI docs |
| [uvicorn](https://www.uvicorn.org) | ASGI server |
| [watchfiles](https://watchfiles.helpmanual.io) | File watcher for uvicorn `--reload` |
| [websockets](https://websockets.readthedocs.io) | WebSocket support |
| [python-multipart](https://github.com/andrew-d/python-multipart) | Multipart form data parsing |
| [fastapi-mcp](https://github.com/tadata-org/fastapi_mcp) | Expose FastAPI routes as MCP tools |
| [mcp](https://github.com/modelcontextprotocol/python-sdk) | MCP protocol SDK; pinned `<2.0.0` — no `fastapi-mcp` release supports `mcp` 2.x yet |

### Database & Migrations
| Package | Purpose |
|---------|---------|
| [sqlalchemy](https://www.sqlalchemy.org) | ORM and SQL toolkit (async via `asyncio` extra) |
| [alembic](https://alembic.sqlalchemy.org) | Schema migrations |
| [aiosqlite](https://aiosqlite.omnilib.dev) | Async SQLite driver (development) |
| [asyncpg](https://magicstack.github.io/asyncpg) | Async PostgreSQL driver (production) |
| [psycopg2-binary](https://www.psycopg.org) | Sync PostgreSQL driver (Alembic offline mode) |

### Security & Auth
| Package | Purpose |
|---------|---------|
| [python-jose](https://python-jose.readthedocs.io) | JWT encoding / decoding |
| [passlib](https://passlib.readthedocs.io) | Password hashing abstraction |
| [bcrypt](https://github.com/pyca/bcrypt) | bcrypt hashing algorithm for passlib |
| [PyJWT](https://pyjwt.readthedocs.io) | Lightweight JWT library |

### Storage
| Package | Purpose |
|---------|---------|
| [fsspec](https://filesystem-spec.readthedocs.io) | Unified filesystem abstraction |
| [s3fs](https://s3fs.readthedocs.io) | S3-compatible fsspec backend (MinIO / AWS S3 / GCS via S3 compat) |
| [minio](https://github.com/minio/minio-py) | MinIO Python client (bucket/policy management) |

### Kubernetes
| Package | Purpose |
|---------|---------|
| [kubernetes](https://github.com/kubernetes-client/python) | Sync Kubernetes API client |
| [kubernetes-asyncio](https://github.com/tomplus/kubernetes_asyncio) | Async Kubernetes API client (job dispatch and log streaming) |

### Data Formats & Scientific
| Package | Purpose |
|---------|---------|
| [libaarhusxyz](https://pypi.org/project/libaarhusxyz) | AEM (airborne EM) XYZ/MagData format handling |
| [msgpack-numpy](https://github.com/lebedov/msgpack-numpy) | NumPy array MessagePack codec |
| [projnames](https://pypi.org/project/projnames) | EPSG code → proj4 string lookup (shared with frontend) |

### Configuration & Utilities
| Package | Purpose |
|---------|---------|
| [pydantic-settings](https://docs.pydantic.dev/latest/concepts/pydantic_settings) | Environment-based settings with validation |
| [python-dotenv](https://github.com/theskumar/python-dotenv) | `.env` file loading |
| [click](https://click.palletsprojects.com) | CLI framework (management commands) |
| [aiosmtplib](https://aiosmtplib.readthedocs.io) | Async SMTP for email notifications |
| [setuptools](https://setuptools.pypa.io) | Package management; used for process-type entrypoint discovery |
| [packaging](https://packaging.pypa.io) | Version parsing/comparison utilities |
| [PyYAML](https://pyyaml.org) | YAML parsing (Kubernetes manifests, config) |
| [ymerflow-plugin-build](https://github.com/YmerFlow/Ymerflow-plugin-sdk) | Frontend-plugin build harness (git dependency); used by `backend/services/job_orchestrator.py` and the `build_frontend_plugin` process type |

---

## Infrastructure

| Component | Purpose |
|-----------|---------|
| [Kubernetes](https://kubernetes.io) | Container orchestration — runs process jobs |
| [Kueue](https://kueue.sigs.k8s.io) | Job queuing and resource quota management |
| [Minikube](https://minikube.sigs.k8s.io) | Local Kubernetes cluster for development |
| [Docker](https://www.docker.com) | Container image builds |
| [MinIO](https://min.io) | S3-compatible object storage (development) |
| [PostgreSQL](https://www.postgresql.org) | Production relational database |
