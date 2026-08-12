# YmerFlow CLI Tool

A command-line interface for managing YmerFlow workspaces.

## Installation

The CLI requires the backend package to be installed:

```bash
pip install -e .
```

## Configuration

The CLI uses the same `.env` file as the backend. It reads the `DATABASE_URL` environment variable to connect to the database.

## Usage

Run the CLI from the project root:

```bash
python backend/cli.py [COMMAND] [ARGS]
```

## Workspace Commands

### List all workspaces

```bash
python backend/cli.py workspace list
```

Output:
```
ID                   Title                          Created
----------------------------------------------------------------------
default              Default                        2026-02-07 14:02:45
my-workspace         My Custom Layout               2026-02-07 20:58:03
```

### Get workspace definition (extract as JSON)

Extract by workspace ID:
```bash
python backend/cli.py workspace get default
```

Extract with pretty-printed JSON:
```bash
python backend/cli.py workspace get default --pretty
```

You can also search by title:
```bash
python backend/cli.py workspace get "Default"
```

### Save workspace from JSON

From a file:
```bash
python backend/cli.py workspace save my-workspace workspace.json
```

From stdin:
```bash
echo '{"title": "New Workspace", "layout": {...}}' | python backend/cli.py workspace save my-workspace -
```

From a saved file:
```bash
python backend/cli.py workspace get default --pretty > backup.json
python backend/cli.py workspace save default-backup backup.json
```

Override the title:
```bash
python backend/cli.py workspace save my-workspace workspace.json --title "My Custom Title"
```

### Delete workspace

With confirmation prompt:
```bash
python backend/cli.py workspace delete my-workspace
```

Skip confirmation:
```bash
python backend/cli.py workspace delete my-workspace --force
```

**Note:** The "default" workspace cannot be deleted.

## JSON Format

The workspace JSON format includes:
- `title` - Display name for the workspace
- `layout` - Flexout layout tree structure (optional, defaults to empty object)

Example:
```json
{
  "title": "My Workspace",
  "layout": {
    "widget": "VerticalSplit",
    "id": "root",
    "splitType": "vertical",
    "children": [
      {
        "id": "pane-1",
        "widget": "FlowView"
      },
      {
        "id": "pane-2",
        "widget": "ProcessEditor"
      }
    ]
  }
}
```

When saving, the `id` and timestamp fields are managed automatically by the database.

## Examples

### Backup all workspaces

```bash
for id in $(python backend/cli.py workspace list | tail -n +3 | awk '{print $1}'); do
  python backend/cli.py workspace get "$id" --pretty > "workspace-${id}.json"
done
```

### Restore a workspace

```bash
python backend/cli.py workspace save default workspace-default.json
```

### Clone a workspace

```bash
python backend/cli.py workspace get default --pretty | \
  python backend/cli.py workspace save my-clone - --title "Clone of Default"
```
