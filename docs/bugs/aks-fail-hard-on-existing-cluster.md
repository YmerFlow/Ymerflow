# Fail hard when an AKS "new cluster" registration collides with an existing cluster or DB row

## Goal

Make the AKS *add-a-new-cluster* flow **refuse** — loudly, early — in every case where it would
otherwise silently bind a new registration to infrastructure or a DB row that already exists.
Today it does the opposite: it adopts a pre-existing Azure cluster and re-applies manifests to it,
producing a DB row that lies about what it points at.

Concretely, after this change, the flow fails hard when:

1. **The Azure AKS cluster already exists** (`az aks show` finds `CLUSTER_NAME` in `RESOURCE_GROUP`)
   — the setup script stops instead of "leaving as-is" and reconfiguring it.
2. **Another DB `Cluster` row already references that same Azure cluster** (same `fqdn`, or same
   `subscription_id` + `resource_group` + `cluster_name`) — the register-callback rejects it.
3. **A DB `Cluster` row with the same display name already exists** — both the register-callback
   (lazy create) and the generic Save path reject it.

## Background — the incident this prevents

On 2026-10-13 an admin used **New Cluster → AKS** to add a West US cluster for customer AGF. They
set Location = `westus` and a custom CPU ceiling (158), but left the pre-filled **AKS Cluster
Name = `ymerflow-aks`** (the shared default) and **Resource Group = `ymerflow`** unchanged. The
setup script's `az aks show "ymerflow-aks" -g "ymerflow"` matched the **existing swedencentral
production cluster**, printed `✓ … leaving as-is`, skipped `az aks create --location westus`, and
then:

- re-applied the `ymerflow-jobs` Karpenter NodePool and the Kueue `ClusterQueue` quota to the live
  production cluster, overwriting its ceiling (verified live: NodePool/quota `cpu=158`, was 160);
- derived `max_node_cpu/mem` from `az vm list-skus --location westus` (127/510) and stored them on
  a row whose FQDN/SP are swedencentral (159/638) — a capacity figure that doesn't match the metal;
- recorded `location=westus` on a row pointing at swedencentral.

No West US cluster was ever created (confirmed: `az aks list` shows one cluster; the only
`MC_*` node resource group is `MC_ymerflow_ymerflow-aks_swedencentral`; Activity Log shows zero
`managedClusters` create/delete since Oct 1). The only genuinely-West-US resource from that session
is the `customeragf` **storage account** (a separate Blob-backend flow, which correctly honored
`westus`). See the first-message analysis; this is unrelated to the minikube-recreate incident
(`docs/bugs/minikube-recreate-destroys-non-bind-mount-volumes.md`).

Root cause in one line: the setup script is not just a *register* step — it *reconfigures whatever
cluster the name resolves to* — and both the name default and the `az aks show … && leave-as-is`
guard make a silent collision the default outcome.

## Files involved (read before implementing)

- `plugins/ymerflow-azure/azure_plugin/scripts/setup-aks.sh.in` — Steps 3–4 (RG + cluster
  check-before-create), Step 10 (callback payload).
- `plugins/ymerflow-azure/azure_plugin/router.py` — `aks_register_callback` (creates/updates the
  pending row from the callback body).
- `plugins/ymerflow-azure/frontend/src/AksClusterForm.jsx` — `DEFAULTS` (pre-filled cluster name)
  and the copy-paste command builder.
- `backend/routers/admin.py` — `_apply_generic_fields` (the Save path that sets `cluster.name`),
  for the generic display-name uniqueness check.

## The three collision points and where each is enforced

| # | Collision | Enforced in | Behavior |
|---|---|---|---|
| 1 | Azure cluster of this name+RG already exists | `setup-aks.sh.in` Step 4 | script exits non-zero before touching anything |
| 2 | Another DB row already points at this Azure cluster (fqdn / sub+rg+name) | `router.py` `aks_register_callback` | HTTP 400, no row created/updated |
| 3 | Another DB row already has this display name | `router.py` callback (create) + `admin.py` `_apply_generic_fields` (Save) | HTTP 400 |

Check #1 is what would have caught *this* bug. Checks #2 and #3 are defense-in-depth: #2 catches a
cross-link even if the script guard is bypassed (e.g. an older script, or a manual callback), and
#3 enforces the name hygiene the user asked for across all cluster types.

## Changes

### 1. `setup-aks.sh.in` — fail hard in Step 4 (the core fix)

Replace the current adopt-on-exists guard:

```bash
if az aks show --name "${CLUSTER_NAME}" --resource-group "${RESOURCE_GROUP}" … >/dev/null 2>&1; then
    echo "✓ Cluster '${CLUSTER_NAME}' already exists — leaving as-is"
else
    … az aks create …
fi
```

with a hard failure (see Design decision A for the two variants). The strict form:

```bash
if az aks show --name "${CLUSTER_NAME}" --resource-group "${RESOURCE_GROUP}" \
        --subscription "${SUBSCRIPTION_ID}" >/dev/null 2>&1; then
    echo "❌ An AKS cluster named '${CLUSTER_NAME}' already exists in resource group"
    echo "   '${RESOURCE_GROUP}'. This 'New cluster' flow will not reconfigure an existing"
    echo "   cluster. Pick a different CLUSTER_NAME (the field is pre-filled with the default"
    echo "   'ymerflow-aks' — change it), or delete the existing cluster first."
    exit 1
fi
echo "Creating AKS cluster '${CLUSTER_NAME}' … "
az aks create …
```

Leave Step 3 (resource group) as check-before-create — sharing an RG across clusters is normal and
correct; the RG is not the identity that collided.

**Idempotency note:** this trades away "re-paste the whole script after a partial failure" for the
cluster-create step only (Steps 5–9 remain idempotent). See Design decision A for the token-tag
variant that keeps safe re-paste.

### 2. `setup-aks.sh.in` Step 10 — report the cluster's *real* region

The callback currently sends the admin-supplied `LOCATION` verbatim. Derive the real one so the row
can never disagree with the metal (belt-and-suspenders now that create is mandatory, but cheap):

```bash
REAL_LOCATION="$(az aks show --name "${CLUSTER_NAME}" --resource-group "${RESOURCE_GROUP}" \
    --subscription "${SUBSCRIPTION_ID}" --query location -o tsv)"
```

and put `REAL_LOCATION` (not `LOCATION`) into the payload's `location` field.

### 3. `router.py` `aks_register_callback` — reject identity + name collisions

Before `test_connection`/persist, after resolving the row by token hash:

```python
# Reject a registration that would cross-link to an Azure cluster already registered under a
# DIFFERENT row (the customer-agf-westus incident: two rows, one swedencentral cluster).
identity_dupe = await db.execute(
    select(Cluster).where(
        Cluster.id != (cluster.id if cluster else None),
        Cluster.cluster_type == "aks",
        # same physical API server, OR same (sub, rg, cluster_name) triple
        or_(
            Cluster.provider_config["fqdn"].astext == body["fqdn"],
            and_(
                Cluster.provider_config["subscription_id"].astext == body["subscription_id"],
                Cluster.provider_config["resource_group"].astext == body["resource_group"],
                Cluster.provider_config["cluster_name"].astext == body["cluster_name"],
            ),
        ),
    )
)
if identity_dupe.scalars().first() is not None:
    raise HTTPException(status_code=400, detail=(
        f"An AKS cluster with FQDN {body['fqdn']} (or {body['resource_group']}/"
        f"{body['cluster_name']}) is already registered. Refusing to create a second row "
        f"pointing at the same cluster."))
```

And when **creating** the lazy row, reject a display-name clash (the callback names it
`body["cluster_name"]`):

```python
name_dupe = await db.execute(select(Cluster).where(Cluster.name == body["cluster_name"]))
if name_dupe.scalars().first() is not None:
    raise HTTPException(status_code=400, detail=f"A cluster named {body['cluster_name']!r} already exists.")
```

(`or_`, `and_` imported from `sqlalchemy`. The `provider_config[...].astext` JSON accessor matches
how the host already queries `json`/`jsonb` columns — confirm the column type is indexable as text;
`clusters.provider_config` is `json`, so `.astext` works under Postgres.)

### 4. `backend/routers/admin.py` `_apply_generic_fields` — name uniqueness on Save

The display name is actually set here (the admin renames the row at Save; this is where
`customer-agf-azure-westus` came from). Add the host-wide check so it applies to every cluster type:

```python
if "name" in body:
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    clash = await db.execute(select(Cluster).where(Cluster.name == name, Cluster.id != cluster.id))
    if clash.scalars().first() is not None:
        raise HTTPException(status_code=400, detail=f"A cluster named {name!r} already exists.")
    cluster.name = name
```

(`_apply_generic_fields` is currently sync; it must take `db` and become `async`, or the name check
moves into the two callers `admin_create_cluster`/`admin_update_cluster`, which are already async and
hold `db`. Prefer moving the check to the callers to keep the helper signature-stable — decide in
Design decision B.)

### 5. `AksClusterForm.jsx` — stop pre-seeding a colliding default name (prevention)

`DEFAULTS.cluster_name: 'ymerflow-aks'` is the trap: it guarantees a collision for anyone who
doesn't hand-edit it. Change it to empty and make the field required before the command renders,
so the admin must consciously name the cluster:

```js
cluster_name: '',   // was 'ymerflow-aks'
```

Add to the pre-command validation already in the component:

```js
if (!fields.cluster_name.trim()) validationError = 'AKS Cluster Name is required.';
```

The copy-paste builder already appends `CLUSTER_NAME=` only when the field is non-empty, so a blank
name simply blocks the command until filled. (Resource Group keeps its `ymerflow` default — shared
RGs are fine.) This is prevention; checks 1–4 are the enforcement that fails hard regardless.

### 6. `setup-aks.sh.in` — make the system-pool SKU overridable + region-validated (robustness)

Surfaced live on 2026-10-28: a West US `az aks create` was rejected with
`The VM size of Standard_B2ls_v2 is not allowed in your subscription in location 'westus'` — West
US offers only the **ARM** B-variants (`b*ps_v2`/`b*pls_v2`), no x86 `B2ls_v2`. `SYSTEM_VM_SIZE` is
**hardcoded** (`SYSTEM_VM_SIZE="Standard_B2ls_v2"`, not `${SYSTEM_VM_SIZE:-…}`), so an admin can't
work around it from the dialog. Two parts:

- Make it overridable: `SYSTEM_VM_SIZE="${SYSTEM_VM_SIZE:-Standard_B2ls_v2}"`, and thread it through
  the frontend command builder as an optional advanced field (default blank → script default).
- Pre-validate against `az vm list-skus --location "${LOCATION}" --query "[?name=='${SYSTEM_VM_SIZE}']"`
  (or catch the create's BadRequest) and fail with a clear "size not available in <region> — pick
  one of […]" message instead of dumping Azure's raw 400. A sensible region-agnostic default that
  exists in most regions (e.g. `Standard_D2als_v6`, 2 vCPU/4 GiB) is a candidate to replace the
  B-series default, since the tiny B SKU's regional availability is spotty.

This is independent of the fail-hard work but belongs in the same "make "new cluster" actually
succeed" pass.

## Design decisions (need your sign-off before implementation)

**A. Script idempotency vs strict fail-hard (Step 4).**
- **A1 — strict (simplest):** `az aks show` finds the cluster → exit 1. Loses safe re-paste of the
  whole script after a partial failure *when the cluster was already created* (admin must
  `az aks delete` and retry, or finish Steps 5–9 by hand). Most literal reading of "fail hard".
- **A2 — token-tagged (recommended):** at create, tag the cluster
  `ymerflow-registration=<sha256(REGISTER_TOKEN)>`. Step 4 fails only if an existing cluster's tag
  is **absent or different** (a foreign/pre-existing cluster); a re-paste with the *same* token sees
  its own tag and proceeds. Keeps safe re-paste **and** fails hard on genuine collisions. ~6 extra
  lines of bash. *Recommended.*

**B. Where the name-uniqueness check lives.** Move it into the async callers
(`admin_create_cluster` / `admin_update_cluster`) to keep `_apply_generic_fields` synchronous, vs.
making the helper async. (Recommend: in the callers.)

**C. DB unique constraint on `clusters.name`?** A migration adding `UNIQUE(name)` would enforce #3
at the schema level too. Current data is already unique, so it won't fail to apply. But it turns a
clash into an opaque `IntegrityError` rather than a friendly 400, and spans all cluster types
forever. (Recommend: **no** constraint — rely on the explicit 400s above, which give a clear
message. Revisit if races matter.)

**D. Scope: AKS-only or all cluster types?** Checks #1/#2 are AKS-specific (Azure identity). Check
#3 (name) is generic and lands in host code, so it covers minikube/gke/kubeconfig too. GKE has the
identical adopt-on-exists pattern in `gcp_plugin/scripts/setup-gke.sh.in` — fix it in the same spirit
in this plan, or defer to a follow-up? (Recommend: fix the AKS flow here; file a follow-up for GKE.)

## Testing

- **Collision (the bug):** register a second AKS row with `CLUSTER_NAME=ymerflow-aks` against the
  existing cluster → script exits 1 at Step 4 (A1), or exits 1 with "tag mismatch" (A2 foreign
  cluster). If forced past the script, the callback returns 400 (identity dupe).
- **Re-paste after partial failure (A2 only):** kill the script after create, re-paste same command
  → proceeds past Step 4 (tag matches), finishes Steps 5–9, callback succeeds.
- **Legit new cluster:** unique `CLUSTER_NAME` in a region → `az aks create` runs, new `MC_*` RG
  and FQDN appear, callback creates a row whose `location`/`fqdn` agree. (See the West US shape
  below for the exact inputs.)
- **Name clash at Save:** two rows, second named the same → PATCH returns 400.
- **No regression:** existing `azure-europe-sweden-2` keeps working; its NodePool/quota are not
  re-touched by any new registration.

## Rollout

- No DB migration (Decision C = no). Pure code: one bash template, one plugin route, one host route,
  one frontend default. The setup script is served live from the backend, so the fix reaches admins
  the moment the backend redeploys — no client action.
- Stale rows left by the incident (`azure-europe-sweden`, `azure-europe-sweden-1`, and the
  mislabeled `customer-agf-azure-westus`) are cleaned up separately; this plan only stops new ones.
```
