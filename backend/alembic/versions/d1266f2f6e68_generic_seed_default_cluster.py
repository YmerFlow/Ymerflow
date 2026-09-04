"""generic seed override for default cluster

Revision ID: d1266f2f6e68
Revises: 9623bab8493d
Create Date: 2026-07-15
"""
import asyncio
import json
import os

from alembic import op
import sqlalchemy as sa

from backend.services.cluster_providers import get_cluster_provider
from backend.services.cluster_job_provisioning import ensure_cluster_job_ready

revision = 'd1266f2f6e68'
down_revision = '9623bab8493d'
branch_labels = None
depends_on = None

DEFAULT_ID = '3f976802-b810-4d20-942c-76da50c37510'


def upgrade() -> None:
    """Generic follow-up to f6a7b8c9d0e1 (initial, now-stale seed) / 5ebf42871eb0 (which
    migrated the seeded row's kubeconfig into cluster_type/provider_config), per Design
    decision 7 in docs/plans/registry-backend-hooks.md: mirror 50dd9ce3311b's generic
    `<AXIS>_PROTOCOL`/`<AXIS>_CONFIG_JSON` pattern for the cluster axis, as a follow-up UPDATE
    rather than an INSERT, since the default row already exists by this point in the migration
    chain. Uses CLUSTER_TYPE (matching Cluster.cluster_type's actual field name, and the same
    var name backend/bin/yf-bootstrap-provision already uses) rather than
    CLUSTER_PROTOCOL.

    If CLUSTER_TYPE/CLUSTER_CONFIG_JSON are both set, an operator has made a deliberate,
    authoritative choice that should win over whatever cluster_type/provider_config the earlier
    fallback-seeding migrations already put in place, so this unconditionally overrides them on
    the default row. If either env var is unset, this is a no-op and today's already-seeded
    values (cluster_type='same-as-backend', provider_config={} from 5ebf42871eb0) stand
    unchanged.

    Unconditional ensure_cluster_job_ready() call, every time this migration runs
    ------------------------------------------------------------------------------
    Per docs/plans/registry-backend-hooks.md Phase 7 / Open items ("A config.env-driven default
    Cluster seeded via bootstrap() ... never goes through register-callback at all"): the default
    Cluster row never goes through POST /admin/clusters/register-callback or admin_create_cluster
    — the only two other call sites of ensure_cluster_job_ready() — regardless of whether an
    operator set CLUSTER_TYPE/CLUSTER_CONFIG_JSON above or left the row at its
    original f6a7b8c9d0e1/5ebf42871eb0-seeded values (cluster_type='same-as-backend'). If
    ensure_cluster_job_ready() were only called inside the `if not cluster_type or not
    config_json: return` early-return's *complement* (i.e. only on an explicit override), the
    vanilla/default local-dev and prod-minikube case — no CLUSTER_TYPE/CLUSTER_CONFIG_JSON set at
    all, by far the common case — would never get Kueue/RBAC/quota provisioning at all, since
    dev/setup-minikube.sh's shell-side provisioning was reduced (Phase 7) to namespace creation
    only. So this call happens unconditionally at the end of upgrade(), using whatever
    cluster_type/provider_config the row ends up with (override or original seed), reading it
    back fresh via SELECT rather than trusting local variables, since the override branch above
    may or may not have run. Alembic only runs a given migration once per database, so this still
    only fires once per fresh DB (dev or prod-minikube) — exactly the "make the default cluster
    job-ready, once" semantics needed, not a repeated-every-migration-run cost.

    Connectivity at migration time: this migration only actually runs in two places today, both
    of which have working K8s connectivity available — prod/runall-production.sh's alembic-migrate
    Job runs in-cluster (so cluster_type='same-as-backend's config.load_incluster_config()
    succeeds), and dev/runall.sh runs yf-migrate host-side with a local kubeconfig pointed
    at minikube (so config.load_kube_config() succeeds). If yf-migrate is ever run
    somewhere with neither in-cluster nor a usable local kubeconfig, this call will fail loudly
    (not silently) — see this phase's implementation report for that caveat.
    """
    cluster_type = os.getenv("CLUSTER_TYPE")
    config_json = os.getenv("CLUSTER_CONFIG_JSON")
    conn = op.get_bind()
    if cluster_type and config_json:
        conn.execute(sa.text("""
            UPDATE clusters SET cluster_type = :cluster_type, provider_config = :provider_config
            WHERE id = :id
        """), {
            "id": DEFAULT_ID,
            "cluster_type": cluster_type,
            "provider_config": json.dumps(json.loads(config_json)),
        })

    # Lightweight sa.table() construct (not raw string interpolation/sa.text) so the JSON
    # column's bind/result processing is handled correctly on both SQLite and Postgres - same
    # pattern 5ebf42871eb0 uses for this same table/column.
    clusters = sa.table(
        'clusters',
        sa.column('id', sa.String),
        sa.column('cluster_type', sa.String),
        sa.column('provider_config', sa.JSON),
        sa.column('namespace', sa.String),
    )
    row = conn.execute(
        sa.select(clusters.c.cluster_type, clusters.c.provider_config, clusters.c.namespace)
        .where(clusters.c.id == DEFAULT_ID)
    ).fetchone()
    if row is None:
        return  # default cluster row doesn't exist in this DB - nothing to make job-ready

    final_cluster_type, final_provider_config, final_namespace = row

    provider = get_cluster_provider(final_cluster_type)
    k8s_client = provider.connect(final_provider_config or {}, final_namespace)
    asyncio.run(ensure_cluster_job_ready(
        k8s_client, final_namespace,
        provider=provider, provider_config=final_provider_config or {},
    ))


def downgrade() -> None:
    pass  # cannot cleanly undo — config may have been legitimately edited since
