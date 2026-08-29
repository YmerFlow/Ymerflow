from backend.models.user import User
from backend.models.storage_backend import StorageBackend
from backend.models.registry_backend import RegistryBackend
from backend.models.cluster import Cluster
from backend.models.project import Project, ProjectMember, ProjectInvite, Publication
from backend.models.api_key import ApiKey
from backend.models.environment import Environment
from backend.models.process import Process, ProcessVersion, ProcessLog, ProcessState, ProcessTag
from backend.models.dataset import Dataset
from backend.models.workspace import Workspace, WorkspaceVersion
from backend.models.tos import TosVersion, UserTosAcceptance
from backend.models.upload import Upload
from backend.models.project_export import ProjectExport, ProjectImport
from backend.models.system import System
from backend.models.plugin import Plugin, PluginVersion, UserPlugin
from backend.models.nav_view import NavView

# Call register_models hook so plugin models (e.g. billing) are registered
# with Base.metadata before any mapper/session is configured.
from backend.hooks import hooks
hooks.run.register_models()

__all__ = [
    "User",
    "StorageBackend",
    "RegistryBackend",
    "Cluster",
    "Project",
    "ProjectMember",
    "ProjectInvite",
    "Publication",
    "ApiKey",
    "Environment",
    "Process",
    "ProcessVersion",
    "ProcessLog",
    "ProcessState",
    "ProcessTag",
    "Dataset",
    "Workspace",
    "WorkspaceVersion",
    "TosVersion",
    "UserTosAcceptance",
    "Upload",
    "ProjectExport",
    "ProjectImport",
    "System",
    "Plugin",
    "PluginVersion",
    "UserPlugin",
    "NavView",
]
