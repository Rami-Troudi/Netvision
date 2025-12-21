import pandas as pd
import json
import os

def detect_congestion(file_path_1, file_path_2, output_path='data.json'):
    # Load datasets
    try:
        df1 = pd.read_csv(file_path_1, delimiter=',')
        df2 = pd.read_csv(file_path_2, delimiter=',')
    except FileNotFoundError as e:
        print(f"Error loading CSVs: {e}")
        return

    # Concatenate datasets
    df = pd.concat([df1, df2], ignore_index=True)

    # Clean column names (strip whitespace, lowercase)
    df.columns = df.columns.str.strip().str.lower()

    # Convert numeric columns
    numeric_cols = [
        'ft_physical_resource_blocks_load_dl', 
        'l_traffic_activeuser_dl_avg', 
        'ft_ave_4g_lte_dl_user_thrput_without_last_tti_all___kbps__kbit_',
        'ot_average_ta',
        'referencesignalpwr',
        'longitude_sector',
        'latitude_sector',
        'azimuth'
    ]
    
    for col in numeric_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors='coerce')

    # Define congestion rules
    def check_congestion(row):
        load = row.get('ft_physical_resource_blocks_load_dl', 0)
        throughput = row.get('ft_ave_4g_lte_dl_user_thrput_without_last_tti_all___kbps__kbit_', 0)
        traffic = row.get('l_traffic_activeuser_dl_avg', 0)
        
        if pd.notna(load) and load > 80:
            return True, "High Load"
        if pd.notna(throughput) and throughput < 1000 and pd.notna(traffic) and traffic > 10:
            return True, "Low Throughput"
        return False, "Normal"

    results = []
    for index, row in df.iterrows():
        is_congested, cause = check_congestion(row)
        
        # Create record
        record = row.to_dict()
        record['congested'] = is_congested
        record['root_cause'] = cause
        
        # Handle NaN for JSON export
        for k, v in record.items():
            if pd.isna(v):
                record[k] = None
                
        results.append(record)

    # Save to JSON
    with open(output_path, 'w') as f:
        json.dump(results, f, indent=2)
    
    print(f"Processed {len(results)} records. Saved to {output_path}")

if __name__ == "__main__":
    detect_congestion(
        'public_data_set_radio_1_page1.csv', 
        'public_data_set_radio_all_hour_page1.csv'
    )
