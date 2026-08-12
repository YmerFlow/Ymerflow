# YmerFlow User Guide

This guide explains how to use YmerFlow for geophysics data processing.

## Getting Started

After installation (see [Deployment Guide](deployment.md)), open your browser to **http://localhost:3000**.

### First Time Setup

1. **Select Environment**: Choose "Bootstrap" from the environment dropdown (top of screen)
2. **Explore the Interface**: The default layout shows:
   - **FlowView** (left): Visual graph of processes
   - **ProcessEditor** (top right): Create/edit processes
   - **ProcessLog** (bottom right): Real-time logs

You can rearrange these widgets by dragging panes, creating splits, or opening tabs.

## Understanding the Interface

### Main Widgets

#### FlowView - Process Graph

Shows a visual graph of all processes and their dependencies:

- **Nodes**: Each process appears as a node
- **Connections**: Lines show data flow (input → process → output)
- **Active Process**: Highlighted node (click to select)
- **Drag**: Rearrange nodes for better visibility
- **Zoom**: Mouse wheel or pinch to zoom in/out

#### ProcessEditor - Create and Edit Processes

Dual-mode editor that changes based on whether a process is selected:

**Create Mode** (no process selected):
1. **Select Process Type**: Choose from dropdown (e.g., "fft", "inversion")
2. **Enter Process Name**: Give your process a meaningful name
3. **Configure Resources**:
   - **Cluster**: Choose which compute cluster runs the process, if more than one is available
   - **CPU**: 0.1 - 8 cores (default: 1)
   - **Memory**: 0.5 - 32 GB (default: 2 GB)
   - **Deadline**: 1 - 1440 minutes (default: 60 minutes)
4. **View Cost Estimate**: If billing is enabled, see the maximum possible cost
5. **Fill Parameters**: Form fields based on process type
6. **Submit**: Click to create and run process

**Edit Mode** (process selected):
- View current parameters
- See output datasets
- Create new version with modified parameters
- **Cancel** a version that is still queued or running
- View process status and history

#### ProcessLog - Real-time Logs

Displays logs from running and completed processes:

- **Status Badges**: Color-coded process states
  - 🔵 **Pending**: Queued, waiting for resources
  - 🟡 **Running**: Currently executing
  - 🟢 **Completed**: Finished successfully
  - 🔴 **Failed**: Execution error
- **Auto-scroll**: Automatically scrolls to latest logs
- **Filter**: Click process to see only its logs
- **Persistent**: Logs remain after process completes

#### PlotView - Data Visualization

Interactive scientific plotting:

- **Add Plot Elements**: Configure data visualization
  - Select dataset from process outputs
  - Choose plot type (Line, Points, etc.)
  - Configure colors, labels, units
- **Interactive**: Zoom, pan, hover for details
- **Multi-dataset**: Overlay multiple datasets
- **Unit Matching**: Automatic axis assignment by units

#### EnvironmentView - Manage Environments

Lists every environment available in the current project:

- **Table view**: Name, Docker image, creator, and creation date for each environment
- **Details**: Click a row to see full details, including packages and process types for
  environments built from a process
- **Creating environments**: Use ProcessEditor to run a "create_environment" process (see
  Creating Custom Environments below)

### Layout Customization

#### Creating Splits

Right-click pane header → "Split Horizontal" or "Split Vertical"

Or drag a pane to edge of another pane to create split.

#### Creating Tabs

Drag a pane to the center of another pane to create tabs.

#### Popout Windows

Click **⧉** button in pane header to open in separate window (great for multi-monitor setups).

#### Changing Widget Type

Use dropdown in pane header to switch widget (e.g., PlotView → EnvironmentView).

#### Closing Panes

Click **×** button in pane header.

#### Workspaces - Saving and Sharing Layouts

A pane layout can be saved as a named **workspace** so you and your collaborators can return to
it later:

- **Save As New Workspace...**: From the Workspaces menu, save the current layout under a new
  name
- **Save**: Once a workspace is loaded, save your changes as a new version of it — older
  versions stay available from a version dropdown next to its name
- **Load a workspace**: Click a workspace's name in the Workspaces menu to switch to it, or pick
  an older version from its dropdown
- **Publish Workspaces...**: Mark one of your workspaces as public so it appears in the public
  gallery for other users to find
- **Public Workspaces...**: Search the public gallery and fork any published workspace into your
  current project as a starting point for your own layout

## Creating and Running Processes

### Process Lifecycle

1. **Create Process**: Define parameters, resources, and (if more than one is available) the
   cluster to run on
2. **Validation**: Checks the parameters against the process type's schema
3. **Billing check** (only if a billing plugin is enabled): Estimates the maximum possible cost,
   checks your balance, and holds the estimated amount
4. **Queuing**: Kueue queues the job until resources are available on the selected cluster
5. **Execution**: Kubernetes pod runs the process, streams logs
6. **Completion** (if billing is enabled): You're charged the actual cost, and the rest of the
   hold is released
7. **Outputs**: Datasets registered and available for visualization

To stop a process before it finishes, click the **Cancel** button in ProcessEditor while the version is shown as pending or running. The Kubernetes job is deleted immediately and the version is marked as failed.

### Step-by-Step: Creating a Process

1. **Deselect any process**: Click empty area in FlowView (ProcessEditor shows "Create" mode)

2. **Select process type**: Choose from dropdown
   - **fft**: Fast Fourier Transform analysis
   - **inversion**: Geophysical inversion
   - **processing**: AEM data processing
   - **import_data**: Import external data

3. **Name your process**: Enter descriptive name (e.g., "FFT Analysis - Line 1")

4. **Configure resources**:

   **Cluster** (if more than one is available):
   - Choose which compute cluster runs the process
   - Each cluster may have its own CPU, memory, and runtime limits — the sliders below adjust to
     match the selected cluster

   **CPU Cores**:
   - 0.1 cores: Light processing
   - 1 core: Standard processing (default)
   - 2-4 cores: Heavy computation
   - 8 cores: Maximum (very intensive)

   **Memory**:
   - 0.5 GB: Minimal data
   - 2 GB: Standard (default)
   - 4-8 GB: Large datasets
   - 16-32 GB: Very large datasets

   **Deadline**:
   - How long process is allowed to run before timeout
   - Be generous - unused time doesn't cost extra
   - Default: 60 minutes

5. **Review cost estimate** (if billing is enabled): Shows the maximum possible cost based on
   the deadline — the actual cost, charged once the process finishes, will be less

6. **Fill in parameters**:
   - Parameters depend on process type
   - **Dataset fields**: Use searchable dropdown to select from previous process outputs
     - Type to search by process name or dataset name
     - Format: "Process Name / v123 / dataset-name"
     - Grouped when >4 datasets from same process
   - **Other fields**: Numbers, text, dropdowns as needed

7. **Submit**: Click "Create Process" button

8. **Monitor progress**:
   - Process appears in FlowView
   - Logs stream to ProcessLog
   - Status updates in real-time

### Example: Running FFT on Imported Data

Assume you've already run an "Import Data" process:

1. Click "Create Process" mode in ProcessEditor
2. Select process type: **fft**
3. Name: "FFT - Survey Line 1"
4. Resources: 1 core, 2 GB, 60 minutes (defaults are fine)
5. Parameters:
   - **Input Data**: Search "Import", select the import process output
6. Click "Submit"
7. Watch FlowView - new "FFT - Survey Line 1" node appears
8. Watch ProcessLog - see "Starting FFT...", progress messages
9. When complete, status shows 🟢 Completed
10. Click the process to view outputs in ProcessEditor

## Working with Datasets

### What are Datasets?

Datasets are output files from processes. Each process can produce multiple datasets (e.g., "result", "diagnostics", "metadata").

### Dataset Types

- **AEM Data** (.msgpack): Airborne electromagnetic survey data
- **Resistivity Models** (.msgpack): Inversion results
- **Plots** (.png, .jpg): Generated figures
- **Tables** (.csv): Tabular data
- **Maps** (.geojson, .geotiff): Geographic data

### Accessing Datasets

**In ProcessEditor** (when process selected):
- "Outputs" section lists all datasets
- Click dataset name to download
- Copy URL to share or use in API calls

**In PlotView**:
- Add plot element
- Select dataset from searchable dropdown
- Visualize immediately

### Dataset Search

When selecting datasets in forms:

- **Type to search**: Searches process names and dataset names
- **Auto-complete**: Matches partial names
- **Grouped results**: Many datasets from same process → shows count
- **Click group**: Refines search to that process
- **Debounced**: Waits 300ms after typing before searching

## Monitoring Processes

### In the UI

#### FlowView Status

- **Node color**: Indicates process state
- **Connections**: Show data dependencies
- **Click node**: Select process to see details

#### ProcessLog

Real-time log streaming:
- **All processes**: Shows logs from all processes by default
- **Filter by process**: Click process in FlowView to filter
- **Auto-scroll**: Keeps latest logs visible
- **Status badges**: Quick state overview

#### ProcessEditor Status

When a process is selected:
- **State**: Current process state
- **Parameters**: What settings were used
- **Outputs**: Links to result datasets
- **History**: Version history if process was modified

### Via Command Line (Advanced)

For administrators or developers:

```bash
# Check jobs
kubectl get jobs -n nagelfluh-jobs

# Check pods
kubectl get pods -n nagelfluh-jobs

# Stream logs
kubectl logs -f <pod-name> -n nagelfluh-jobs

# Check queue status
kubectl get workloads -n nagelfluh-jobs
```

## Billing and Costs

Billing is an optional, pluggable feature. If your Nagelfluh installation has a billing plugin
enabled, you'll see cost estimates and balance information when creating and running processes.
If it doesn't, this section doesn't apply — processes simply run.

### How It Works

When a billing plugin is active:

- **Before running**: The system estimates the maximum possible cost for a process (based on
  the requested resources and deadline) and checks that your account balance can cover it
- **While running**: The estimated amount is held against your balance
- **After completion**: You're charged the actual cost, based on actual runtime and resources
  used, and any unused portion of the hold is released back to your balance

Exact pricing, plans, and top-up options depend on how your installation's billing plugin is
configured — check your account page for current rates and balance.

### Viewing Balance and Transactions

If billing is enabled, your account page shows your current balance, plan usage, and a full
transaction history (top-ups, holds, charges, releases, and subscription fees). Clicking a
transaction that's linked to a process takes you to that process.

### Tips for Managing Costs

1. **Set realistic deadlines**: Don't overestimate - you're not charged for unused time
2. **Right-size resources**: Start with defaults (1 core, 2 GB), increase if needed
3. **Monitor usage**: Check ProcessLog to see how long processes actually run
4. **Reuse results**: Datasets persist - don't re-run unnecessarily
5. **Test with small data**: Validate workflow before processing full datasets

## Managing Projects and Environments

### Projects

Each project has:
- **Isolated storage**: Its own storage bucket, on a backend you choose when you create the
  project
- **Separate processes**: Processes don't cross projects
- **Dedicated credentials**: Scoped IAM permissions
- **Independent billing**: Track costs per project (if billing is enabled)

#### Creating a Project

From the project dropdown, choose "Create New Project...":

1. **Name the project**
2. **Choose a storage backend**: If your installation offers more than one place to store
   project data, pick one here
3. **Optionally import from an export**: Attach a previously exported project zip to seed the
   new project with its processes, datasets, and uploads instead of starting empty

### Project Membership

Projects can have multiple collaborators. From "Manage Members..." in the project dropdown:

- **Invite a collaborator**: Create an invite link, optionally tied to an email address, and
  share it. Anyone who opens the link and accepts it joins the project
- **Pending Invites**: See and cancel invites that haven't been accepted yet
- **Members**: See everyone who currently has access to the project
- **Leave a project**: Remove yourself from a project you no longer need access to

### Publications - Read-Only Sharing

A publication is a read-only link into a project — anyone who opens it can view the project's
processes and datasets, but can never make changes. Publications are created from the
"Publications" tab in "Manage Members...":

- **Create a publication**: Optionally make it findable in every user's Projects list, and
  optionally allow anonymous access (no login required)
- **Copy the link**: Share it with anyone who needs to see the project's results
- **Delete a publication**: Revokes the link immediately

### Project Export and Import

"Export Project..." in the project dropdown packs a project's processes, versions, output
datasets, uploads, and tags into a downloadable zip archive. Attach that zip when creating a new
project (see Creating a Project above) to seed it with the same data — the import only ever
affects the new project, never the original.

### Environments

Environments define the available process types and Docker images:

- **Bootstrap**: Default environment with basic process types
- **Custom environments**: Created via a "create_environment" process
  - Define custom Docker images
  - Install specific libraries
  - Configure environment variables

Use the EnvironmentView widget to browse the environments available in a project and see
details for each one.

### Creating Custom Environments

1. Run a "create_environment" process
2. Specify a base Docker image, and any Python packages or extra Dockerfile instructions needed
3. System builds and pushes the Docker image
4. New environment appears in the environment dropdown

### Administration

If you're an administrator, additional panels are available for managing clusters, storage
backends, and installed plugins — look for the admin link in the navigation once signed in with
an administrator account.

## Troubleshooting

### Process Stuck in "Pending"

**Cause**: Insufficient cluster resources

**Solutions**:
1. Wait - Kueue will schedule when resources free up
2. Check cluster capacity: `kubectl get nodes`
3. Reduce resource requirements (fewer cores/memory)
4. Contact administrator to scale cluster

### Process Failed Immediately

**Cause**: Parameter validation error or missing dependencies

**Solutions**:
1. Check ProcessLog for error messages
2. Verify all required parameters filled
3. Check dataset URLs are valid
4. Ensure input datasets exist

### Can't Find Dataset in Selector

**Cause**: Dataset not created yet or search too broad

**Solutions**:
1. Verify source process completed successfully
2. Refine search - type more specific process name
3. Click grouped results to narrow search
4. Check ProcessEditor outputs of source process

### Logs Not Updating

**Cause**: WebSocket connection lost

**Solutions**:
1. Refresh browser page
2. Check browser console for errors
3. Verify backend is running: `curl http://localhost:8000`
4. Check network connectivity

### Process Exceeded Deadline

**Cause**: Process took longer than deadline setting

**Solutions**:
1. Increase deadline in next run
2. Optimize process parameters (smaller dataset, fewer iterations)
3. Increase CPU cores to speed up processing
4. Check if process hung (logs stopped updating)

### Storage Permission Denied

**Cause**: IAM policy misconfiguration

**Solutions**:
1. Verify project storage was created automatically
2. Check Kubernetes secret exists: `kubectl get secret project-{id}-storage`
3. Contact administrator to verify IAM policies
4. Check ProcessLog for specific error message

### Out of Balance

**Cause**: Insufficient funds for process creation (only applies if your installation has
billing enabled)

**Solutions**:
1. Check your current balance and transaction history on your account page
2. Top up your balance, or contact your administrator to add funds
3. Reduce resource requirements or deadline
4. Cancel a queued or running process to release its held funds back to your balance

## Best Practices

### Process Naming

- **Be descriptive**: "FFT Line 1 - High Frequency" not "test1"
- **Include context**: Survey name, line number, variant
- **Use consistent format**: Makes searching easier

### Resource Allocation

- **Start conservative**: Use defaults, increase if needed
- **Monitor actual usage**: Check logs for "actual runtime"
- **Right-size**: Don't request 8 cores for simple tasks
- **Generous deadlines**: Better to overestimate than timeout

### Dataset Management

- **Descriptive output names**: Name outputs clearly in process code
- **Document parameters**: Include metadata in outputs
- **Clean up old data**: Delete unnecessary datasets (UI coming soon)
- **Organize by project**: Keep related work in same project

### Workflow Organization

- **Use FlowView**: Arrange nodes to show workflow clearly
- **Version control**: Create new process versions rather than deleting
- **Document decisions**: Use process names to indicate variations
- **Save layouts**: Save your pane layout as a workspace so you can return to it later or share
  it with collaborators (see Workspaces)

### Performance Tips

- **Parallel processing**: Run independent processes simultaneously
- **Reuse datasets**: Don't re-import or re-process unnecessarily
- **Optimize parameters**: Reduce iterations, simplify models for testing
- **Use smaller samples**: Test workflows on subset before full dataset

## Keyboard Shortcuts

(Coming soon)

- **Ctrl+N**: New process
- **Ctrl+S**: Save layout
- **Ctrl+F**: Search datasets
- **Esc**: Deselect process
- **Delete**: Remove selected process

## Getting Help

### Documentation

- **[Architecture Docs](architecture/overview.md)**: Understand how it works
- **[Development Guide](development.md)**: For contributors
- **[Deployment Guide](deployment.md)**: For administrators

### Support

- **GitHub Issues**: https://github.com/emerald-geomodelling/nagelfluh/issues
- **Documentation**: Check `/help` command in application
- **Logs**: Always include ProcessLog output when reporting issues

## Glossary

- **Process**: A computational job that transforms data
- **Dataset**: Output file from a process
- **Environment**: Collection of available process types
- **Project**: Isolated workspace with own storage and billing
- **Widget**: UI component (FlowView, ProcessEditor, etc.)
- **Pane**: Container for a widget in the layout
- **Workspace**: A saved, versioned pane layout that can be reloaded, shared, and forked
- **Publication**: A read-only, shareable link into a project
- **Invite**: A link used to add a collaborator to a project
- **Cluster**: A Kubernetes cluster processes can run on; an installation may offer more than one
- **Kueue**: Job queuing system that manages cluster resources
- **Pod**: Kubernetes container that runs a process
- **AEM**: Airborne Electromagnetic (geophysical survey method)
- **Inversion**: Geophysical processing to estimate resistivity
