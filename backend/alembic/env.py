from logging.config import fileConfig
import importlib
import importlib.metadata

from sqlalchemy import engine_from_config
from sqlalchemy import pool

from alembic import context

# Import database Base and models
from backend.database import Base
from backend.config import settings

# Import every registered model module (core + plugins) so autogenerate sees all tables. Core
# registers backend.models under ymerflow.models in setup.py, so it is discovered here too —
# no separate `import backend.models`.
for ep in importlib.metadata.entry_points(group='ymerflow.models'):
    importlib.import_module(ep.value)

# Call the register_models fan-out hook (plugins that build metadata imperatively). Errors
# propagate — a plugin that fails to register its models must fail loudly, not silently.
from backend.hooks import hooks
hooks.run.register_models()

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# Override sqlalchemy.url with our settings
# Strip async driver specifier so alembic's sync engine can connect
_db_url = settings.database_url
_db_url = _db_url.replace("postgresql+asyncpg://", "postgresql://")
config.set_main_option("sqlalchemy.url", _db_url)

# Interpret the config file for Python logging.
# This line sets up loggers basically.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# add your model's MetaData object here
# for 'autogenerate' support
target_metadata = Base.metadata

# other values from the config, defined by the needs of env.py,
# can be acquired:
# my_important_option = config.get_main_option("my_important_option")
# ... etc.


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.  By skipping the Engine creation
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.

    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode.

    In this scenario we need to create an Engine
    and associate a connection with the context.

    """
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
