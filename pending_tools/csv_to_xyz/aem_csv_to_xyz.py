"""
aem_csv_to_xyz.py
=================
Convert comma-separated AEM files to Aarhus Workbench XYZ format for import
into YmerFlow / libaarhusxyz.

Two public functions
--------------------
data_csv_to_xyz(csv_file, output_file=None)
    Raw AEM data files (flight data XYZ). Column name mapping is handled
    separately via an ALC file at import time — this function only converts
    the file format (comma-separated → space-separated, NaN → *).

model_csv_to_xyz(csv_file, output_file=None, units='m',
                 column_map=None, drop_columns=None)
    Inversion model files (SCI / LCI resistivity models). All column names
    are lowercased in the output. Supply column_map to rename columns to the
    canonical names libaarhusxyz expects.

TODOs
-----
- Column mapping automation: currently requires manual column_map
  specification. Add interactive or LLM-assisted column identification for
  users running without an LLM in the loop.
- Unit handling: the 'units' parameter is informational only. Future versions
  should derive the active unit system from the CRS (EPSG code) and
  auto-select the correct column group rather than relying on manual
  column_map entries.
- Halfspace layer: Aarhus Workbench inversion exports have N layers with
  N-1 finite thicknesses (the last layer is a halfspace with inf thickness).
  Detect and handle this case before passing to libaarhusxyz / simpleem3.
  Related: simpleem3 has a bug where the halfspace thickness is not handled
  correctly — see TODO.md for details.
- YmerFlow model import process: a dedicated YmerFlow process type for
  importing model XYZ files is needed. The current import_skytem process is
  data-only and requires a GEX file. See TODO.md.
"""

import csv
import re
import pandas as pd
from pathlib import Path


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _dedup_columns(columns):
    """Rename duplicate column names with underscore suffixes.

    Comparison is case-insensitive so that 'line' and 'Line' are treated as
    duplicates. The first occurrence keeps its name; subsequent ones get _1,
    _2, etc.
    """
    seen = {}
    result = []
    for col in columns:
        key = col.lower()
        if key in seen:
            seen[key] += 1
            result.append(f'{col}_{seen[key]}')
        else:
            seen[key] = 0
            result.append(col)
    return result


_RE_LAYER_COL = re.compile(r'^(.*?)(\[[0-9]+\].*)$')


def _apply_column_map(columns, column_map):
    """Rename columns according to column_map and lowercase everything.

    Handles both scalar columns (exact match) and layer columns (prefix match
    for names of the form 'PREFIX[N]'). All comparisons are case-insensitive.
    The returned names are all lowercase.

    Parameters
    ----------
    columns : sequence of str
    column_map : dict
        {original_name_or_prefix: canonical_name}
    """
    map_lower = {k.lower(): v.lower() for k, v in column_map.items()}

    result = []
    for col in columns:
        col_lower = col.lower()

        # Exact match
        if col_lower in map_lower:
            result.append(map_lower[col_lower])
            continue

        # Prefix match for layer columns  e.g. 'DEP_TOP_M[5]'
        m = _RE_LAYER_COL.match(col_lower)
        if m:
            prefix, suffix = m.group(1), m.group(2)
            if prefix in map_lower:
                result.append(map_lower[prefix] + suffix)
                continue

        # No match — just lowercase
        result.append(col_lower)

    return result


def _write_xyz(df, output_file):
    """Write df to a space-separated XYZ file with NaN represented as *."""
    df.to_csv(
        output_file,
        sep=' ',
        na_rep='*',
        index=False,
        quoting=csv.QUOTE_NONE,
        escapechar='\\',
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def data_csv_to_xyz(csv_file, output_file=None):
    """Convert a comma-separated AEM data file to Aarhus Workbench XYZ format.

    Column name mapping for non-standard names is handled separately via an
    ALC file at import time. This function only converts the file format
    (comma-separated → space-separated, NaN → *) and deduplicates column
    names so that post-ALC renaming does not create duplicate column names
    that would crash libaarhusxyz's normalizer.

    Parameters
    ----------
    csv_file : str or Path
        Input CSV. First row must be a comma-separated column header.
    output_file : str or Path, optional
        Output path. Defaults to same directory and base name as csv_file
        with a .xyz extension.

    Returns
    -------
    Path
        Path to the written XYZ file.
    """
    csv_file = Path(csv_file)
    if output_file is None:
        output_file = csv_file.with_suffix('.xyz')
    output_file = Path(output_file)

    print(f"Reading: {csv_file.name}")
    df = pd.read_csv(csv_file)
    print(f"  {len(df):,} rows, {len(df.columns)} columns")

    # Deduplicate case-insensitively so that e.g. 'line' and 'Line' are
    # treated as duplicates. The ALC uses 1-based column positions for
    # mapping, so column order — not names — is what matters here.
    df.columns = _dedup_columns(df.columns)

    print(f"Writing: {output_file.name}")
    _write_xyz(df, output_file)
    print("Done.")
    return output_file


def model_csv_to_xyz(
    csv_file,
    output_file=None,
    units='m',
    column_map=None,
    drop_columns=None,
):
    """Convert a comma-separated AEM inversion model file to Aarhus Workbench
    XYZ format.

    All column names in the output are lowercased. Use column_map to rename
    columns to the canonical names libaarhusxyz expects. Columns not in
    column_map pass through lowercased but otherwise unchanged.

    All columns are written to the output — nothing is dropped unless
    explicitly listed in drop_columns. This means ft-unit and m-unit column
    groups both appear in the file; only the ones included in column_map get
    canonical names that libaarhusxyz will recognise for coordinate, depth,
    and DOI calculations.

    For layer columns (names with a [N] index, e.g. 'DEP_TOP_M[0]'), the
    column_map key should be the group prefix only ('DEP_TOP_M'). The rename
    is applied to all columns in that group automatically.

    Parameters
    ----------
    csv_file : str or Path
        Input CSV. First row must be a comma-separated column header.
    output_file : str or Path, optional
        Output path. Defaults to same directory and base name as csv_file
        with a .xyz extension.
    units : str, optional
        Active unit system — 'm' (metres, default) or 'ft' (feet).
        Currently informational only. Use column_map to control which unit's
        columns receive canonical names. CRS-based auto-selection is a TODO.
    column_map : dict, optional
        Mapping of original column names (or layer-group prefixes) to
        canonical libaarhusxyz names. Keys are matched case-insensitively.

        Typical entries for a metre-unit SCI/LCI model file:

            column_map = {
                # Scalar columns
                'Line':         'line_no',
                'East_UTM_M':   'x',
                'North_UTM_M':  'y',
                'DEM_M':        'elevation',
                'ALT_M':        'alt',
                'DOI_UPPER_M':  'doi_conservative',
                'DOI_LOWER_M':  'doi_standard',
                # Layer group prefixes (applied to all [N] in each group)
                'DEP_TOP_M':    'dep_top',
                'DEP_BOT_M':    'dep_bot',
                'THK_M':        'thk',
            }

        Columns absent from column_map (e.g. ft-unit columns, SIGMA_I, RHO_I)
        pass through with their lowercased names. libaarhusxyz will still
        detect RHO_I[N] as layer data via its [N] pattern matching.

    drop_columns : list of str, optional
        Columns to remove from the output. Matching is case-insensitive.

    Returns
    -------
    Path
        Path to the written XYZ file.
    """
    csv_file = Path(csv_file)
    if output_file is None:
        output_file = csv_file.with_suffix('.xyz')
    output_file = Path(output_file)

    if column_map is None:
        column_map = {}
    if drop_columns is None:
        drop_columns = []

    print(f"Reading: {csv_file.name}")
    df = pd.read_csv(csv_file)
    print(f"  {len(df):,} rows, {len(df.columns)} columns")
    print(f"  units={units!r}  mapped={len(column_map)} keys  "
          f"dropping={len(drop_columns)} columns")

    # Drop explicitly requested columns (case-insensitive)
    if drop_columns:
        drop_lower = {c.lower() for c in drop_columns}
        df = df[[c for c in df.columns if c.lower() not in drop_lower]]

    # Apply column_map (lowercases everything, exact + prefix matching)
    df.columns = _apply_column_map(df.columns, column_map)

    # Deduplicate (columns are already lowercase at this point)
    df.columns = _dedup_columns(df.columns)

    print(f"Writing: {output_file.name}")
    _write_xyz(df, output_file)
    print("Done.")
    return output_file