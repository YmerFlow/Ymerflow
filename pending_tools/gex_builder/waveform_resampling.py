import pandas as pd
import numpy as np
import io
# import matplotlib as mpl
import matplotlib.pyplot as plt
from rdp import rdp


# --- CONSTANTS ---
# Small value used to prevent log(0) errors. Must be smaller than any expected non-zero amplitude.
LOG_EPSILON = 1e-12

# Define common unit-to-seconds scale factors
UNIT_SCALES = {'s': 1.0,
               'ms': 1e-3,
               'us': 1e-6,
               'ns': 1e-9,
               'ps': 1e-12,
               'min': 60.0,
               'µs': 1e-6, # Explicitly include mu-symbol (as shown in your file)
               'Hz': 1.0,
              }

# --- IER HELPER FUNCTION ---
def _calculate_segment_error(points, df_original, start_index, end_index):
    """
    Calculates the maximum perpendicular distance error for the segment between 
    start_index and end_index relative to the original points.
    
    Returns: (max_error, max_error_index_in_original)
    """
    # 1. Get the simplified segment line (start_point to end_point)
    p1 = points[start_index]
    p2 = points[end_index]
    
    # 2. Get the subset of original points between p1 and p2 (exclusive of the endpoints)
    # We use the time value of p1's corresponding point in the original data to find the range.
    time_p1 = p1[0]
    time_p2 = p2[0]
    
    # Filter the original DataFrame for points strictly between the segment endpoints
    original_segment_subset = df_original[
        (df_original.iloc[:, 0] > time_p1) & (df_original.iloc[:, 0] < time_p2)
    ]
    
    if original_segment_subset.empty:
        return 0.0, -1

    # 3. Calculate Perpendicular Distance for all intermediate points
    intermediate_points = original_segment_subset.iloc[:, [0, 1]].values
    
    # Vector p2 - p1 (Segment Vector)
    v = p2 - p1
    
    # Calculate vector p1 to P_intermediate
    w = intermediate_points - p1
    
    # Calculate the normalized position along the segment line (dot product projection)
    l2 = np.dot(v, v) # Squared length of the segment vector
    
    if l2 == 0.0:
        # p1 and p2 are the same point (shouldn't happen with unique points, but safety check)
        distances = np.sqrt(np.sum(w**2, axis=1))
        max_error_index_in_subset = np.argmax(distances)
        max_error = distances[max_error_index_in_subset]
    else:
        # t = projection of w onto v, scaled by l2
        t = np.sum(w * v, axis=1) / l2
        t = np.clip(t, 0.0, 1.0) # Clamp t to [0, 1] for perpendicular distance on segment line

        # Closest point on the line segment
        closest_points = p1 + t[:, np.newaxis] * v
        
        # Distance squared
        d2 = np.sum((intermediate_points - closest_points)**2, axis=1)
        distances = np.sqrt(d2)
        
        max_error_index_in_subset = np.argmax(distances)
        max_error = distances[max_error_index_in_subset]
        
    # Get the original index of the point with max error
    max_error_original_index = original_segment_subset.index[max_error_index_in_subset]
    
    return max_error, max_error_original_index
        
    return 0.0, -1 # Should only reach here if original_segment_subset was empty

# --- 2. Weighted Iterative Max Error Downsampling Function ---
def max_error_downsampling(df, max_points=21, time_col='seconds (s)', amp_col='n_amp', split_perc=0.80, tail_weight=5, use_log_transform=False):
    """
    Implements the Iterative Max Error Reduction (IER) method to downsample 
    the waveform to exactly max_points.
    
    This function now supports a 'tail_weight' parameter to prioritize the 
    insertion of points in the end segment (the tail).
    
    :param split_perc: The fractional time point to define the tail (e.g., 0.80 for the last 20% of time).
    :param tail_weight: Multiplies the error for any segment whose start point is past the split_perc time.
    """
    
    # --- 1. Setup ---
    working_amp_col = amp_col
    df_working = df[[time_col, amp_col]].copy()
    
    if use_log_transform:
        working_amp_col = f'log_{amp_col}'
        df_working[working_amp_col] = np.log10(df_working[amp_col] + LOG_EPSILON)
    
    # Calculate the split time for error weighting
    total_duration = df_working[time_col].max() - df_working[time_col].min()
    split_time = df_working[time_col].min() + (split_perc * total_duration)

    # --- 2. Intelligent Initialization: Find the anchor point with max error ---
    indices = [df_working.index[0], df_working.index[-1]]
    temp_points_df = df_working.loc[indices, [time_col, working_amp_col]].reset_index(drop=True)
    
    # Calculate error for the entire segment (index 0 to 1)
    max_error, max_error_original_index = _calculate_segment_error(
        temp_points_df.values, 
        df_working, 
        start_index=0, 
        end_index=1
    )
    
    # Indices now includes the initial best anchor point
    if max_error_original_index != -1:
        # Check to avoid inserting duplicates if max error happens to be on p1 or p2
        if max_error_original_index != df_working.index[0] and max_error_original_index != df_working.index[-1]:
            indices.insert(1, max_error_original_index) # Insert the best point between start and end
            print(f"Intelligent Start: Found initial best anchor point with error {max_error:.4e}.")
        else:
            indices.insert(1, df_working.index[len(df_working) // 2])
            print("Intelligent Start: Max error was endpoint. Fallback to middle anchor point.")

    else:
        # Fallback to simple middle point if max error could not be found 
        indices.insert(1, df_working.index[len(df_working) // 2])
        print("Intelligent Start: Fallback to middle anchor point.")

    # Ensure indices are unique and sorted
    indices = sorted(list(set(indices)))
    current_points_df = df_working.loc[indices, [time_col, working_amp_col]].reset_index(drop=True)
    
    print(f"Starting Weighted Max Error Iteration. Initial points: {len(current_points_df)}. Tail Weight: {tail_weight} at {int(split_perc*100)}%")
    
    # --- 3. Iteration Loop ---
    # The loop runs until we reach the target number of points
    while len(current_points_df) < max_points:
        current_points = current_points_df[[time_col, working_amp_col]].values
        num_segments = len(current_points) - 1
        
        max_overall_error = -1
        index_to_insert = -1
        segment_to_split = -1
        
        # Iterate over all segments
        for i in range(num_segments):
            # Calculate the unweighted error for the segment (i to i+1)
            unweighted_error, original_index = _calculate_segment_error(
                current_points, 
                df_working, 
                start_index=i, 
                end_index=i+1
            )
            
            current_error = unweighted_error
            
            # Check if the segment is in the tail (segment start time is after the split time)
            segment_start_time = current_points[i, 0]
            
            if segment_start_time >= split_time and tail_weight > 1.0:
                current_error *= tail_weight
            
            # Track the maximum *weighted* error found so far
            if current_error > max_overall_error:
                max_overall_error = current_error
                index_to_insert = original_index
                segment_to_split = i
        
        # Check if we found a valid point to insert
        if index_to_insert == -1 or max_overall_error <= 0:
            print(f"⚠️ Warning: Could not find segment with error to split. Stopping at {len(current_points_df)} points.")
            break
            
        # Insert the new point (the one with the max weighted error)
        new_point_data = df_working.loc[index_to_insert, [time_col, working_amp_col]]
        
        # Concatenate the points before the split point, the new point, and the points after the split point
        df_before = current_points_df.iloc[:segment_to_split + 1]
        df_after = current_points_df.iloc[segment_to_split + 1:]
        
        # Create a DataFrame for the new point
        df_new_point = pd.DataFrame([new_point_data.tolist()], columns=[time_col, working_amp_col])

        # Recombine the DataFrame, dropping duplicates (in case the new point was already an endpoint)
        current_points_df = pd.concat([df_before, df_new_point, df_after]).drop_duplicates(subset=[time_col]).sort_values(by=time_col).reset_index(drop=True)

        # The loop termination condition is checked at the top, but we can print here
        if len(current_points_df) == max_points:
            print(f"Target Hit: Max Points reached.")
            break
        
    # --- 4. Finalize Results ---
    df_combined = current_points_df.copy()

    # Inverse Transform if log was used
    if use_log_transform:
        df_combined[amp_col] = np.power(10, df_combined[working_amp_col]) - LOG_EPSILON
        df_combined.drop(columns=[working_amp_col], inplace=True)
        
    n_final = len(df_combined)
    
    print(f"✅ Weighted Max Error Downsampling Done. Max Points: {max_points}. Resulting Points: {n_final}.")
    print(f"   Mode: {'Logarithmic' if use_log_transform else 'Linear'}")

    return df_combined

# --- RDP Functions (Retained but not the primary focus) ---
# --- 1. RDP Binary Search Helper Function (with aggressive fine-tuning) ---
def _rdp_search_tolerance(points, max_points):
    """
    Finds the smallest RDP tolerance that produces <= max_points, 
    then fine-tunes the result to get as close to max_points as possible.
    """
    if len(points) <= max_points:
        return points, 0.0

    epsilon_low = 1e-10
    x_range = points[:, 0].max() - points[:, 0].min()
    y_range = points[:, 1].max() - points[:, 1].min()
    epsilon_high = np.sqrt(x_range**2 + y_range**2)

    best_tolerance = epsilon_high
    
    # Binary search phase (Finds the optimal tolerance for <= max_points)
    for _ in range(20):
        mid_tolerance = (epsilon_low + epsilon_high) / 2
        simplified = rdp(points, epsilon=mid_tolerance)
        n_simplified = len(simplified)

        if n_simplified <= max_points:
            best_tolerance = mid_tolerance
            epsilon_high = mid_tolerance
        else:
            epsilon_low = mid_tolerance
            
    # Fine-Tuning Phase: Search downward from the best_tolerance to get closer to max_points
    # We step backward (smaller epsilon) to increase the point count towards the limit.
    final_points = rdp(points, epsilon=best_tolerance)
    current_points = len(final_points)
    
    # Calculate a tiny step size based on the difference between the low and high bounds
    fine_step = (epsilon_low - best_tolerance) / 500 

    while current_points < max_points and fine_step < 0 and best_tolerance > 1e-12:
        test_tolerance = best_tolerance + fine_step # Fine_step is negative, so this decreases tolerance
        
        # Test the smaller tolerance
        test_points = rdp(points, epsilon=test_tolerance)
        N_test = len(test_points)
        
        if N_test <= max_points:
            # If the new, smaller tolerance still meets the constraint, accept it
            # and try an even smaller tolerance next.
            final_points = test_points
            current_points = N_test
            best_tolerance = test_tolerance
        else:
            # If the smaller tolerance violates the constraint, we stop.
            break

    return final_points, best_tolerance

# --- 3. Split-RDP Downsampling Function (Retained for comparison) ---
def rdp_split_downsampling(df, max_points=21, time_col='seconds (s)', amp_col='n_amp', split_perc=0.80, use_log_transform=False):
    """
    Applies RDP downsampling with a weighted point budget for max_points=21:
    - Segment 1 (First 3/4 time): 10 points
    - Segment 2 (Last 1/4 time - Turn Off): 11 points
    - Includes optional log-amplitude transformation.
    """
    
    # Create a temporary working column name
    working_amp_col = amp_col
    
    # Log Transformation Implementation
    if use_log_transform:
        # Check if the column is already log-transformed (shouldn't happen, but good check)
        working_amp_col = f'log_{amp_col}'
        if working_amp_col not in df.columns:
            # Apply log transformation: log10(amplitude + epsilon)
            df[working_amp_col] = np.log10(df[amp_col] + LOG_EPSILON)
        
    # Define the 10/11 budget split explicitly using numpy functions
    # Note: This is 10 points for Seg 1 (front) and 11 points for Seg 2 (turn-off)
    points_budget_1 = int(np.floor(max_points / 2))  # 10 points
    points_budget_2 = int(np.ceil(max_points / 2))   # 11 points
    
    # --- 1. Define Segments ---
    total_duration = df[time_col].max() - df[time_col].min()
    split_time = df[time_col].min() + (split_perc * total_duration)

    # Use the appropriate amplitude column for splitting
    df_seg1 = df[df[time_col] <= split_time].copy()
    df_seg2 = df[df[time_col] >= split_time].copy()
    
    if len(df_seg1) < 2 or len(df_seg2) < 2:
        print("⚠️ Warning: Segment split failed. Returning original data.")
        # If log transform was applied, clean up the temporary column
        if use_log_transform and working_amp_col in df.columns:
            df.drop(columns=[working_amp_col], inplace=True)
        return df
        
    # --- 2. Apply RDP Separately to Each Segment ---
    points1 = df_seg1[[time_col, working_amp_col]].values
    points2 = df_seg2[[time_col, working_amp_col]].values
    
    final_points1, tol1 = _rdp_search_tolerance(points1, points_budget_1)
    final_points2, tol2 = _rdp_search_tolerance(points2, points_budget_2)
    
    # --- 3. Combine and Finalize Results ---
    df_result1 = pd.DataFrame(final_points1, columns=[time_col, working_amp_col])
    df_result2 = pd.DataFrame(final_points2, columns=[time_col, working_amp_col])

    # Drop the duplicate point at the boundary (first row of result2)
    df_combined = pd.concat([df_result1, df_result2.iloc[1:]], ignore_index=True)

    # Inverse Transform if log was used
    if use_log_transform:
        # Inverse log: 10^(log_amplitude) - epsilon
        df_combined[amp_col] = np.power(10, df_combined[working_amp_col]) - LOG_EPSILON
        # Drop the temporary log column
        df_combined.drop(columns=[working_amp_col], inplace=True)
        
        # Clean up the original DataFrame just in case
        if working_amp_col in df.columns:
            df.drop(columns=[working_amp_col], inplace=True)

    n_final = len(df_combined)
    
    print(f"✅ Split RDP Done. Max Points: {max_points}. Resulting Points: {n_final}.")
    print(f"   Mode: {'Logarithmic' if use_log_transform else 'Linear'}")
    print(f"   Segment 1 (0-{int(round(split_perc*100))}% Time): Used {len(df_result1)}/{points_budget_1} points, Tol: {tol1:.4e}")
    print(f"   Segment 2 ({int(round(split_perc*100))}-100% Time, Turn Off): Used {len(df_result2)-1}/{points_budget_2} points, Tol: {tol2:.4e}")

    return df_combined

# --- 4. Plotting Function ---
def plot_waveforms(df_original, df_downsampled, time_col='shift_time', amp_col='n_amp', split_perc=0.80, title_prefix="Waveform Downsampling"):
    """
    Plots the original and downsampled waveforms on a Matplotlib canvas 
    for visual comparison.
    """
    
    fig, ax = plt.subplots(1, 1, figsize=(10, 6))
    
    # Plot the Original Waveform
    ax.plot(
        df_original[time_col], 
        df_original[amp_col], 
        label='Original Waveform', 
        color='C0', 
        linewidth=2, 
        alpha=0.6
    )
    
    # Plot the Downsampled Waveform
    ax.plot(
        df_downsampled[time_col], 
        df_downsampled[amp_col], 
        label=f'Simplified ({len(df_downsampled)} points)', 
        color='C1', 
        marker='o', 
        linestyle='-', 
        linewidth=1.5,
        markersize=6
    )

    # Only show split line if the RDP function was used
    if 'Split RDP' in title_prefix:
        total_duration = df_original[time_col].max() - df_original[time_col].min()
        split_time = df_original[time_col].min() + (split_perc * total_duration)
        
        ax.axvline(
            split_time, 
            color='gray', 
            linestyle='--', 
            label=f'{int(round(split_perc*100))}% Time Split Boundary'
        )
    
    # Canvas Formatting
    ax.set_title(f'{title_prefix} Comparison')
    ax.set_xlabel(time_col)
    ax.set_ylabel(amp_col)
    ax.legend()
    ax.grid(True, linestyle=':', alpha=0.7)
    plt.tight_layout()
    return fig, ax


def plot_gtimes_trapez_filter(gates_array, gt1, gt2, gt3, gw1, gw2, gw3, fs=None):
    pw = int(np.ceil(np.max([gw1/2, gw2/2, gw3/2])*1.1))
    if not fs is None:
        h_sound_loc = np.array(list(range(0, pw, fs))) # fs is m/s - points will be be output at 1 second...
        sound_loc = np.sort(np.unique(np.concatenate([h_sound_loc, -h_sound_loc])))
    else:
        sound_loc = np.array([-pw, pw])
    
    fix, ax = plt.subplots(1, 1, figsize=(8, 8))
    
    ax.plot(0, gates_array.iloc[0], marker='o', linestyle='', c='b', label='gate times')
    for ii, time in enumerate(gates_array):
        if fs is None:
            sound_label = None
            g_marker=''
        elif (not fs is None) and (ii==0):
            sound_label = f'~Sounding Locations\n@ 1sec @ {fs} m/s'
            g_marker='o'
        else:
            sound_label = None
            g_marker='o'
        ax.plot(sound_loc, np.ones(len(sound_loc))*time, marker=g_marker, linestyle='-', markersize=1, alpha=0.75, lw=0.25, c='b', label=sound_label)
    ax.plot(np.zeros(len(gates_array)), gates_array, marker='o', linestyle='', c='b', label=None)
    
    ax.plot([-gw2/2, -gw2/2], [gt2, np.max(gates_array)], marker='', linestyle='-', alpha=0.75, lw=0.25, c='r', label=None)
    ax.plot([-gw1/2, -gw1/2], [gt1, np.max(gates_array)], marker='', linestyle='-', alpha=0.75, lw=0.25, c='r', label=None)
    ax.plot([gw1/2, gw1/2], [gt1, np.max(gates_array)], marker='', linestyle='-', alpha=0.75, lw=0.25, c='r', label=None)
    ax.plot([gw2/2, gw2/2], [gt2, np.max(gates_array)], marker='', linestyle='-', alpha=0.75, lw=0.25, c='r', label=None)
    
    ax.plot([-gw1/2, -gw1/2, -gw2/2, -gw3/2, -gw3/2], [np.min(gates_array), gt1, gt2, gt3, np.max(gates_array)], '-r', label="averaging window")
    ax.plot([gw1/2, gw1/2, gw2/2, gw3/2, gw3/2], [np.min(gates_array), gt1, gt2, gt3, np.max(gates_array)], '-r', label=None)
    
    if fs is None:
        ax.plot([-gw1/2, gw1/2], [gt1, gt1], marker='', linestyle='dashed',          alpha=0.9, lw=1, c='r', label=f"{gw1}m")
        ax.plot([-gw2/2, gw2/2], [gt2, gt2], marker='', linestyle='dashdot',         alpha=0.9, lw=1, c='r', label=f"{gw2}m")
        ax.plot([-gw3/2, gw3/2], [gt3, gt3], marker='', linestyle=(0, (3, 5, 1, 5)), alpha=0.9, lw=1, c='r', label=f"{gw3}m")
    else:
        nsgw1 = int(np.round(gw1/fs))
        nsgw2 = int(np.round(gw2/fs))
        nsgw3 = int(np.round(gw3/fs))
        if np.mod(nsgw1, 2) == 0:
            nsgw1+=1
        else:
            pass
        if np.mod(nsgw2, 2) == 0:
            nsgw2+=1
        else:
            pass
        if np.mod(nsgw3, 2) == 0:
            nsgw3+=1
        else:
            pass
        ax.plot([-gw1/2, gw1/2], [gt1, gt1], marker='', linestyle='dashed',          alpha=0.9, lw=1, c='r', label=f"{gw1}m ({nsgw1} soundings)")
        ax.plot([-gw2/2, gw2/2], [gt2, gt2], marker='', linestyle='dashdot',         alpha=0.9, lw=1, c='r', label=f"{gw2}m ({nsgw2} soundings)")
        ax.plot([-gw3/2, gw3/2], [gt3, gt3], marker='', linestyle=(0, (3, 5, 1, 5)), alpha=0.9, lw=1, c='r', label=f"{gw3}m ({nsgw3} soundings)")
    
    ax.invert_yaxis()
    
    if not fs is None:
        def forward_unit_to_fs(x):
            """Converts primary (x) units to secondary (top) units (x / fs)."""
            return x / fs
        def inverse_fs_to_unit(x_u):
            """Converts secondary (top) units back to primary (x) units (x * fs)."""
            return x_u * fs
        
        sec_ax = ax.secondary_xaxis('top', functions=(forward_unit_to_fs, inverse_fs_to_unit))
        sec_ax.set_xlabel('Number of 1s soundings')
        ax.tick_params(top=False, labeltop=False, bottom=True, labelbottom=True)
    else:
        ax.tick_params(top=True, labeltop=False, bottom=True, labelbottom=True)
    
    ax.set_yscale('log')
    plt.legend(loc='upper right')
    ax.set_title('Measurement Times vs. Trapez Times and Widths')
    ax.set_ylabel("Measurement Time (s)")
    ax.set_xlabel("Distance from Soundings for Averaging (m)")
    plt.tight_layout()
    plt.show()

def parse_metadata_line(line):
    """
    Parses a header line containing a keyword, value, and unit (e.g., 'Sample Interval: 1.0000000 µs').

    Returns: dict with {'value': float, 'unit': str} or None if parsing fails.
    """
    try:
        # 1. Split key from value/unit
        # The line is expected to be like: "/ Sample Interval: 1.0000000 µs"
        # We need to strip the leading '/' first
        line_content = line.lstrip('/').strip()

        # Check if the line has a colon, otherwise it's likely the column header line
        if ':' not in line_content:
            return None

        # Split at the first colon
        _, value_unit_str = line_content.split(': ', 1)

        # 2. Extract value and unit from the right side
        # value_unit_str example: "1.0000000 µs"
        parts = value_unit_str.strip().split()

        if len(parts) >= 2:
            value = float(parts[0])
            unit = parts[1]
            return {unit: value}

    except Exception as e:
        # Log error but return None to continue processing
        print(f"Error parsing metadata line '{line.strip()}': {e}")
        return None

    return None

def read_ascii_file_custom(file_stream, escape='/', keywords_to_find=['Base Frequency', 'Sample Interval']):
    """
    Reads an ASCII data file line by line, separating header lines (starting with the escape character(S))
    from data lines, parsing metadata, and loading data into a DataFrame.

    Args:
        file_stream: A file-like object (e.g., open file handle or io.StringIO).
        keywords_to_find (list): A list of metadata keywords to search for in the header.

    Returns:
        tuple: (pandas.DataFrame, dict of metadata)
    """

    header = []
    data_lines = []
    metadata = {}

    print("--- Starting File Read (Python's 'while not feof' Equivalent) ---")

    # Python's 'for line in file_stream' is the idiomatic equivalent of
    # reading until EOF (End Of File).
    for line in file_stream:
        stripped_line = line.strip()

        # Skip empty lines
        if not stripped_line:
            continue

        # Check for the escape character (escape) to determine if it's a header line
        if stripped_line.startswith(escape):
            header.append(stripped_line)
        else:
            # If the first data line is encountered, we stop collecting header info
            # and append the rest as data
            data_lines.append(stripped_line)

    print(f"Read complete. Found {len(header)} header lines and {len(data_lines)} data lines.")

    # --- 1. METADATA PARSING ---
    for h_line in header:
        for keyword in keywords_to_find:
            if keyword in h_line:
                result = parse_metadata_line(h_line)
                if result:
                    # Convert keyword to a clean dictionary key (e.g., 'Base Frequency' -> 'base_frequency')
                    key = keyword.lower().replace(' ', '_')
                    metadata[key] = result
                    print(f"✅ Parsed Metadata: {keyword} = {result}")
                    break  # Move to the next header line

    # --- 2. COLUMN HEADER EXTRACTION ---
    column_names = None
    if header:
        # The last line of the header list is the column names
        header_line = header[-1]

        # Remove the leading escape character ('/') and split on any whitespace
        column_names = header_line.lstrip('/').strip().split()
        print(f"✅ Extracted Column Headers: {column_names}")

    # --- 3. DATA LOADING ---
    df = pd.DataFrame()
    if data_lines and column_names:
        # Use io.StringIO to treat the collected data lines as an in-memory file for pandas
        data_stream = io.StringIO('\n'.join(data_lines))

        try:
            # Read data using pandas.
            # sep='\s+' handles variable whitespace as a delimiter.
            # header=None tells pandas not to use the first line of the data_stream as a header.
            df = pd.read_csv(
                data_stream,
                sep='\s+',
                header=None,
                names=column_names,
                comment=None  # We've already filtered out comment/header lines
            )
            print(f"✅ Data loaded successfully. DataFrame shape: {df.shape}")
        except Exception as e:
            print(f"⚠️ Warning: Could not load data into DataFrame: {e}")
            df = pd.DataFrame()

    if not 's' in metadata['sample_interval'].keys():
        metadata['sample_interval']['s'] = metadata['sample_interval'][
                                               list(metadata['sample_interval'].keys())[0]] * UNIT_SCALES[
                                               list(metadata['sample_interval'].keys())[0]]

    orig_col = df.columns.to_list()
    colmap = {}
    for ocol in orig_col:
        ncol = ocol.lower()
        ncol = ncol.replace('[', '_')
        ncol = ncol.replace(']', '_')
        colmap[ocol] = ncol
    df.rename(columns=colmap, inplace=True)
    df['time_s'] = df['sample'] * metadata['sample_interval']['s']

    return df, metadata

def find_zero_crossings(df, amplitude_col_name, direction='all'):
    """
    Identifies the index immediately preceding a sign change (zero-crossing)
    in the amplitude data, robustly handling points that are exactly zero.

    Args:
        df (pd.DataFrame): The DataFrame containing time and amplitude data.
        amplitude_col_name (str): The name of the amplitude column to check.
        direction (str): Specifies the type of crossing to find:
                         - 'all' (default): Finds all sign changes.
                         - 'positive': Finds Negative-to-Positive crossings (data[i] <= 0 and data[i+1] > 0).
                         - 'negative': Finds Positive-to-Negative crossings (data[i] >= 0 and data[i+1] < 0, the "turn off").

    Returns:
        pd.DataFrame: A DataFrame containing the rows just before the zero-crossing.
    """

    if df.empty or amplitude_col_name not in df.columns:
        print(f"Error: Amplitude column '{amplitude_col_name}' not found or DataFrame is empty.")
        return pd.DataFrame()

    # Get the amplitude data as a NumPy array for efficient calculation
    amplitude_data = df[amplitude_col_name].to_numpy()
    n = len(amplitude_data)

    # Prepare indices for element i and element i+1
    i = amplitude_data[:-1]  # All elements except the last
    i_plus_1 = amplitude_data[1:]  # All elements except the first

    crossing_mask = np.array([], dtype=bool)

    if direction == 'negative':
        # Robust Positive to Negative crossing (the "turn off"):
        # Current point (i) is non-negative AND next point (i+1) is negative.
        crossing_mask = (i >= 0) & (i_plus_1 < 0)

    elif direction == 'positive':
        # Robust Negative to Positive crossing (the "turn on"):
        # Current point (i) is non-positive AND next point (i+1) is positive.
        crossing_mask = (i <= 0) & (i_plus_1 > 0)

    elif direction == 'all':
        # Find any sign change (i >= 0 and i+1 < 0) OR (i <= 0 and i+1 > 0)
        neg_crossing = (i >= 0) & (i_plus_1 < 0)
        pos_crossing = (i <= 0) & (i_plus_1 > 0)
        crossing_mask = neg_crossing | pos_crossing

    # Get the 0-based indices from the boolean mask
    crossing_indices = np.where(crossing_mask)[0]

    if not crossing_indices.size:
        print(f"No {direction}-going zero-crossings found in column '{amplitude_col_name}'.")
        return pd.DataFrame()

    # Return the DataFrame rows corresponding to the indices just before the crossing
    # The index returned is the index of 'i' (the point >= 0 just before the drop)
    crossing_points = df.iloc[crossing_indices]

    return crossing_points