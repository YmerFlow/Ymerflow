# Debug Harness Setup Guide

## Status: Ready to Use ✅

Your configuration has been successfully extracted from the database!

## What Was Created

All files are in the `debug-harness/` directory:

- ✅ `config.json` - **EXTRACTED FROM DATABASE** for process `e90107f9-9b4c-46c8-bbc7-b1ea713f5528`
- ✅ `debug_runner.py` - Debug wrapper with pdb post-mortem
- ✅ `run_debug.sh` - Docker launcher script
- ✅ `extract_config.py` - Database extraction tool (already used)

## Configuration Summary

From your database:
- **Process Type**: `invert_tem` (Dual moment TEM inversion)
- **Process ID**: `e90107f9-9b4c-46c8-bbc7-b1ea713f5528`
- **Version**: 1
- **Project ID**: `65344a50-7e6a-4bb6-8961-6f77d93c8197`

## Required Setup

### ✅ Credentials Auto-Loaded from .env

The debug harness automatically loads credentials from your `.env` file! It will use:
1. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (if present)
2. Or `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` (for local dev)

Your `.env` already has:
```bash
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=minioadmin
STORAGE_ENDPOINT=http://localhost:9000
```

**No manual editing needed!** 🎉

### Ensure Storage is Accessible

The config uses:
- **Storage endpoint**: `http://localhost:9000`
- **Bucket**: `s3://ymerflow-project-65344a50-7e6a-4bb6-8961-6f77d93c8197`

**Docker networking note:**
- On **Linux**: Use `http://localhost:9000` or add `--network=host` to docker run
- On **Mac/Windows**: Change to `http://host.docker.internal:9000`

If your MinIO is running in K8s, you may need to port-forward:
```bash
kubectl port-forward -n ymerflow-jobs svc/minio-ymerflow 9000:9000
```

## Running the Debug Harness

Just run it! Credentials are auto-loaded from `.env`:

```bash
cd debug-harness
./run_debug.sh
```

The script will show you which credentials it's using:
```
Loading environment from /home/redhog/Projects/beta/Nagelfluh/.env
Credentials Source: MINIO_ROOT_USER from .env
AWS Access Key: minioAdm...
```

## What Will Happen

1. Docker container starts with your exact K8s configuration
2. Process runs: loads input data, starts inversion
3. **When error occurs**, drops you into pdb debugger:
   ```
   ValueError: operands could not be broadcast together with shapes (11830,) (3640,)
   ```

## Debugging the Shape Error

The error occurs in SimPEG's `uncert_array` property when it tries to broadcast arrays of different shapes.

In the pdb debugger, try these commands:

```python
# Show current location
w

# Navigate to the error frame
u  # up until you see the uncert_array property

# Inspect the array shapes
p self.data_array_nan.shape  # Expected: some shape
p stds.shape                 # Expected: matching shape
p noise.shape                # Expected: matching shape

# Check the uncert configuration
p self.uncert
pp self.uncert  # pretty print

# Look at the data
p len(self.data_array_nan)  # Should match stds length

# Check survey configuration
p self.survey
p len(self.survey.source_list)
```

### Likely Causes

The shape mismatch (11830 vs 3640) suggests:
1. Mismatch between number of data points and number of uncertainties
2. Possibly related to gate filtering or dual-moment configuration
3. May be an issue with how uncertainties are applied to filtered data

Your configuration has:
- Gate filter: LM gates 5-11, HM gates 12-26
- Dual moment system
- This might be causing a mismatch in expected data sizes

## Alternative: Quick Test Without Storage

If you just want to see where the error occurs without storage setup:

1. Edit `run_debug.sh` and comment out storage-related env vars
2. The process will fail earlier (when loading data), but you can still inspect the code

## Tips

- Use `l` (list) to see code around current line
- Use `pp <variable>` to pretty-print complex objects
- Use `!<statement>` to execute arbitrary Python code
- Type `help` in pdb for full command list

## Next Steps After Debugging

Once you identify the root cause:
1. The fix may need to go in `aem_processes/inversion_process.py`
2. Or it may be a data preparation issue in the processing step
3. Or a configuration issue with gate filtering

Good luck debugging! 🐛
