from backend.routers.auth import router as auth_router
from backend.routers.projects import router as projects_router
from backend.routers.publications import router as publications_router
from backend.routers.environments import router as environments_router
from backend.routers.processes import router as processes_router
from backend.routers.datasets import router as datasets_router
from backend.routers.workspaces import router as workspaces_router
from backend.routers.uploads import router as uploads_router
from backend.routers.utilities import router as utilities_router
from backend.routers.systems import router as systems_router
from backend.routers.tags import router as tags_router
from backend.routers.plugins import router as plugins_router, assets_router as plugin_assets_router
from backend.routers.internal import router as internal_router
from backend.routers.admin import router as admin_router
from backend.routers.stats import router as stats_router
from backend.routers.nav import router as nav_router

__all__ = [
    "auth_router",
    "projects_router",
    "publications_router",
    "environments_router",
    "processes_router",
    "datasets_router",
    "workspaces_router",
    "uploads_router",
    "utilities_router",
    "systems_router",
    "tags_router",
    "plugins_router",
    "plugin_assets_router",
    "internal_router",
    "admin_router",
    "stats_router",
    "nav_router",
]
