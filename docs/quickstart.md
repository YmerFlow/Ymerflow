# Quickstart

Get from zero to a running YmerFlow development environment in four steps.

## Prerequisites

Install these system tools before starting:

| Tool | Purpose | Install |
|------|---------|---------|
| Python 3.11+ | Backend runtime & venv | `apt install python3 python3-venv` |
| Node.js 16+ | Frontend build | [nodejs.org](https://nodejs.org) or `apt install nodejs npm` |
| Docker | Container builds | [docs.docker.com/get-docker](https://docs.docker.com/get-docker/) |
| Minikube | Local Kubernetes | [minikube.sigs.k8s.io](https://minikube.sigs.k8s.io/docs/start/) |
| kubectl | Kubernetes CLI | `apt install kubectl` or bundled with Minikube |
| screen | Multi-window terminal | `apt install screen` |

Minikube needs at least **4 CPUs and 16 GB RAM** allocated (configured in `config.env`).

## Setup

**1. Copy the config file:**

```bash
cp config.env.example config.env
```

The defaults work for a first run. Adjust `MINIKUBE_CPUS` and `MINIKUBE_MEMORY` if your machine has different resources.

**2. Start everything:**

```bash
./runall.sh
```

On first run this takes several minutes — it sets up Minikube, Kueue, MinIO, a local Docker registry, a Python virtualenv, npm dependencies, database migrations, and the runner image. Subsequent runs are fast and skip steps already done.

**3. Open the app:**

```
http://localhost:3000
```

The backend API is at `http://localhost:8000` (interactive docs at `/docs`).

Services run in a `screen` session named `nagelfluh-dev`. To watch the logs:

```bash
screen -r nagelfluh-dev   # attach
# Ctrl+A, N / P            switch windows (backend / frontend / monitor)
# Ctrl+A, D                detach without stopping
```

## First steps in the UI

1. Select an **environment** (e.g. "Bootstrap") from the dropdown.
2. Choose a **process type** (e.g. "fft" or "inversion").
3. Configure resources (CPU, memory, deadline) and process parameters.
4. Click **Submit** — the job runs in Kubernetes with real-time log streaming.

See the **[User Guide](user-guide.md)** for a complete walkthrough.

## After a reboot

Minikube and the screen session don't survive a reboot. Just re-run:

```bash
./runall.sh
```

It's idempotent — safe to run as many times as needed.

## Next steps

- **[Deployment Guide](deployment.md)** — production mode, admin tools, cloud deployment
- **[Development Guide](development.md)** — adding process types, frontend widgets, debugging
- **[Architecture Overview](architecture/overview.md)** — how the pieces fit together
