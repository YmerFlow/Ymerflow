#!/usr/bin/env python3
"""
Create a fake webxtile process for testing GridLayer / WebxtileDataset.

Generates a 1024×1024 synthetic grid (~1366 tile files), uploads to MinIO,
inserts project/process/dataset records into the SQLite DB, and saves a
pre-configured workspace so the Playwright test can open it directly.

Usage (from project root):
    env/bin/python tests/webxtile/setup.py
"""

import sys, json, uuid, sqlite3, tempfile, urllib.request, urllib.error
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / 'deps/webxtile/py'))
sys.path.insert(0, str(ROOT))

import numpy as np
import xarray as xr
from minio import Minio
from webxtile import write_webxtile

# ── Test credentials ─────────────────────────────────────────────────────────
TEST_USERNAME = 'webxtile_test'
TEST_PASSWORD = 'webxtile_test_pass'

print('Ensuring test user exists...')
try:
    req = urllib.request.Request(
        'http://localhost:8000/auth/signup',
        data=json.dumps({'username': TEST_USERNAME, 'password': TEST_PASSWORD}).encode(),
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    urllib.request.urlopen(req)
    print(f'  Created user {TEST_USERNAME}')
except urllib.error.HTTPError as e:
    body = e.read()
    if e.code == 400 and b'already exists' in body:
        print(f'  User {TEST_USERNAME} already exists')
    else:
        raise

# ── IDs ──────────────────────────────────────────────────────────────────────
PROJECT_ID   = str(uuid.uuid4())
PROCESS_ID   = str(uuid.uuid4())
DATASET_ID   = str(uuid.uuid4())
WORKSPACE_ID = str(uuid.uuid4())
DATASET_NAME = 'webxtile_test'

BUCKET    = f'ymerflow-project-{PROJECT_ID}'
TILE_PATH = f'processes/{PROCESS_ID}/1/datasets/{DATASET_ID}'
BASE_URL  = f'http://localhost:8000/files/{BUCKET}/{TILE_PATH}'

# ── Generate tile pyramid ─────────────────────────────────────────────────────
print('Generating 1024×1024 synthetic grid (max_leaf=32 → ~1366 tiles)...')
N = 1024
x = np.linspace(500_000.0, 520_000.0, N, dtype=np.float32)
y = np.linspace(6_200_000.0, 6_220_000.0, N, dtype=np.float32)
xg, yg = np.meshgrid(x, y, indexing='ij')

ds = xr.Dataset(
    {
        'elevation':   (['x', 'y'], (100 * np.sin(xg / 2000) * np.cos(yg / 2000) + 200).astype(np.float32)),
        'resistivity': (['x', 'y'], (10 ** (2 + np.sin(xg / 3000) * np.cos(yg / 3000))).astype(np.float32)),
    },
    coords={'x': x, 'y': y},
    attrs={'epsg_code': 32632},
)

with tempfile.TemporaryDirectory() as tmpdir:
    tile_dir = Path(tmpdir) / 'tiles'
    write_webxtile(ds, tile_dir, spatial_dims=['x', 'y'], max_leaf=32, crs='EPSG:32632')

    tile_files = sorted(tile_dir.iterdir())
    print(f'Generated {len(tile_files)} tile files')

    # ── Upload to MinIO ───────────────────────────────────────────────────────
    print(f'Uploading to minio: {BUCKET}/{TILE_PATH}/')
    client = Minio('localhost:9000', access_key='minioadmin', secret_key='minioadmin', secure=False)
    if not client.bucket_exists(BUCKET):
        client.make_bucket(BUCKET)

    for i, f in enumerate(tile_files, 1):
        client.fput_object(BUCKET, f'{TILE_PATH}/{f.name}', str(f),
                           content_type='application/octet-stream')
        if i % 200 == 0 or i == len(tile_files):
            print(f'  {i}/{len(tile_files)} uploaded')

    print('Upload complete.')

# ── Database records ──────────────────────────────────────────────────────────
print('Inserting database records...')
db = sqlite3.connect(str(ROOT / 'ymerflow.db'))

env_id = db.execute("SELECT id FROM environments LIMIT 1").fetchone()
if not env_id:
    raise RuntimeError('No environment in DB — start the backend first so it seeds the bootstrap env.')
env_id = env_id[0]

now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')

db.execute("INSERT INTO projects (id, name, created_at) VALUES (?,?,?)",
           (PROJECT_ID, 'WebXtile Test Project', now))

db.execute("""INSERT INTO processes (id, name, type, environment_id, project_id, created_at)
              VALUES (?,?,?,?,?,?)""",
           (PROCESS_ID, 'webxtile_test_process', 'test_webxtile', env_id, PROJECT_ID, now))

db.execute("""INSERT INTO process_versions
                (process_id, version, parameters, state, dependencies, deadline_seconds,
                 created_at, updated_at)
              VALUES (?,1,'{}','DONE','[]',3600,?,?)""",
           (PROCESS_ID, now, now))
version_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]

db.execute("""INSERT INTO datasets
                (id, mime_type, process_id, process_name, process_version_id,
                 dataset_name, project_id, parts, created_at)
              VALUES (?,?,?,?,?,?,?,?,?)""",
           (DATASET_ID, 'application/x-webxtile', PROCESS_ID, 'webxtile_test_process',
            version_id, DATASET_NAME, PROJECT_ID,
            json.dumps({'files': {'application/x-webxtile': BASE_URL}}),
            now))

# Pre-configured workspace: PlotView with a GridLayer using the test dataset.
plot_layout_config = {
    'transforms': [],
    'layers': [{
        'GridLayer': {
            'dataset':   DATASET_NAME,
            'xData':     f'{DATASET_NAME}.x',
            'yData':     f'{DATASET_NAME}.y',
            'zData':     f'{DATASET_NAME}.elevation',
            'colorData': f'{DATASET_NAME}.resistivity',
            'xAxis': 'xaxis_bottom',
            'yAxis': 'yaxis_left',
            'zAxis': 'zaxis_bottom_left',
        },
    }],
    'axes': {},
}

workspace_layout = {
    'id': 'root',
    'widget': 'VerticalSplit',
    'children': [
        {'id': 'flow', 'widget': 'FlowView'},
        {
            'id': 'bottom',
            'widget': 'TabSet',
            'activeTab': 'plot',
            'children': [
                {'id': 'editor', 'widget': 'ProcessEditor'},
                {'id': 'plot',   'widget': 'PlotView',
                 'layoutConfig': plot_layout_config},
            ],
        },
    ],
}

db.execute("""INSERT INTO workspaces (id, title, layout, created_at, updated_at)
              VALUES (?,?,?,?,?)""",
           (WORKSPACE_ID, 'WebXtile Test', json.dumps(workspace_layout), now, now))

db.commit()
db.close()

# ── Summary ───────────────────────────────────────────────────────────────────
frontend_url = f'http://localhost:3000/app/w/{WORKSPACE_ID}/p/{PROJECT_ID}/pr/{PROCESS_ID}/v/1'
print(f"""
Done!
  Project ID:    {PROJECT_ID}
  Workspace ID:  {WORKSPACE_ID}
  Dataset URL:   {BASE_URL}
  Tile count:    {len(tile_files)}

Frontend URL (open this to test manually):
  {frontend_url}

To run the Playwright tests:
  npx playwright test tests/webxtile/test.spec.js --project=chromium
""")

# Write IDs to a file so the Playwright test can read them without env vars
ids_file = Path(__file__).parent / '.ids.json'
ids_file.write_text(json.dumps({
    'project_id':   PROJECT_ID,
    'process_id':   PROCESS_ID,
    'workspace_id': WORKSPACE_ID,
    'dataset_id':   DATASET_ID,
    'base_url':     BASE_URL,
    'frontend_url': frontend_url,
    'username':     TEST_USERNAME,
    'password':     TEST_PASSWORD,
}))
print(f'IDs saved to {ids_file}')
