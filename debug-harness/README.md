# YmerFlow Process Debug Harness

This test harness allows you to debug failed Kubernetes jobs locally using `docker run -it` with pdb post-mortem debugging.

## Files

- `debug_runner.py` - Python wrapper that adds try/except/pdb around the runner
- `run_debug.sh` - Shell script to run the Docker container with debug configuration
- `extract_config.py` - Helper to extract configuration from your database
- `config.json.template` - Template configuration file

## Quick Start

### Option 1: Extract from Database (Recommended)

If your database is accessible:

```bash
cd /home/redhog/Projects/beta/Nagelfluh
python debug-harness/extract_config.py e90107f9-9b4c-46c8-bbc7-b1ea713f5528 \
    -o debug-harness/config.json
```

Then review and edit the generated `config.json` if needed.

### Option 2: Manual Configuration

Copy the template and fill in your values:

```bash
cd debug-harness
cp config.json.template config.json
# Edit config.json with your actual values
```

## Running the Debug Harness

Once you have a `config.json`:

```bash
cd debug-harness
./run_debug.sh
```

## What Happens

1. The script reads your `config.json`
2. Starts a Docker container with:
   - Your existing image (`ymerflow-default:0.1`)
   - Debug wrapper mounted at `/app/debug_runner.py`
   - All environment variables set from config
3. Runs the process
4. When an error occurs, drops you into pdb post-mortem

## pdb Commands

When you're in the debugger after an error:

- `w` or `where` - Show the current stack frame
- `u` or `up` - Move up one stack frame
- `d` or `down` - Move down one stack frame
- `l` or `list` - List code around current line
- `p <expr>` - Print a variable or expression
- `pp <expr>` - Pretty-print a variable or expression
- `bt` - Show full backtrace
- `args` - Show arguments to current function
- `!<statement>` - Execute arbitrary Python code
- `q` or `quit` - Quit the debugger

## Debugging the Shape Error

Based on your error:
```
ValueError: operands could not be broadcast together with shapes (11830,) (3640,)
```

This occurs in `uncert_array` property. In the debugger, you can inspect:

```python
# Check the shapes
p self.data_array_nan.shape
p stds.shape
p np.abs(self.data_array_nan).shape

# Check where the data comes from
p self.data_array_nan
p self.uncert
```

## Notes

- The Docker container runs with `--rm` so it will be cleaned up after exit
- Debug runner is mounted read-only to avoid modifying the image
- Your current directory is mounted at `/debug` if you need to access local files
- Storage URLs in the config must be accessible from within the container

## Troubleshooting

### Database Not Found

If `extract_config.py` can't find your database, set the DATABASE_URL:

```bash
export DATABASE_URL="sqlite:///path/to/your/ymerflow.db"
python extract_config.py ...
```

### Storage Not Accessible

If your process needs to access S3/MinIO storage:

1. Make sure `storage_endpoint` points to a host accessible from Docker
2. Use `host.docker.internal` instead of `localhost` on Mac/Windows
3. Or use `--network=host` in the docker run command (Linux only)

### Input Files Not Found

If you're using local files instead of S3:

1. Mount the directory containing your data:
   ```bash
   docker run ... -v /path/to/data:/data ...
   ```
2. Update URLs in config.json to use `file:///data/...` paths
