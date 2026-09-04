# Debug Harness Updates

## ✅ Automatic .env Credential Loading

Both scripts now automatically load credentials from your `.env` file!

### Changes Made

#### 1. `run_debug.sh`
- Automatically loads `.env` from project root
- Prioritizes credentials in this order:
  1. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` from `.env`
  2. `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` from `.env`
  3. Values from `config.json` (if not placeholders)
- Shows which credential source is being used
- Validates that credentials are found before running

#### 2. `extract_config.py`
- Loads `.env` before extracting from database
- Automatically populates credentials in generated `config.json`
- Shows confirmation message when credentials are loaded
- Warns if no credentials found

### Your Current Setup

Based on your `.env`:
```bash
STORAGE_ENDPOINT=http://localhost:9000
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=minioadmin
STORAGE_PROTOCOL=s3
STORAGE_BUCKET_PREFIX=ymerflow-project-
```

**Result**: Debug harness will use `minioadmin` credentials automatically! 🎉

### Testing

The config was re-extracted and now shows:
```json
"aws_access_key_id": "minioadmin",
"aws_secret_access_key": "minioadmin",
```

No manual editing required!

### What You Need to Do

**Nothing!** Just run:
```bash
cd debug-harness
./run_debug.sh
```

The script will:
1. Load `.env` automatically
2. Show you which credentials it's using
3. Connect to MinIO at `http://localhost:9000`
4. Run your process with pdb debugging

### For Production/Different Environments

If you need different credentials:

**Option 1**: Add to `.env`
```bash
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
```

**Option 2**: Set environment variables
```bash
export AWS_ACCESS_KEY_ID=your-key
export AWS_SECRET_ACCESS_KEY=your-secret
cd debug-harness && ./run_debug.sh
```

**Option 3**: Edit `config.json` directly (not recommended)
