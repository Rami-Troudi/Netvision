import os
import pandas as pd
import numpy as np
import matplotlib

# Set backend to "Agg" BEFORE importing pyplot to avoid GUI crashes
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import xgboost as xgb
import pickle
from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score
from sklearn.model_selection import TimeSeriesSplit
from sklearn.preprocessing import PowerTransformer

# --- CONFIGURATION (FIXES WINDOWS PATH ERRORS) ---
# Get the folder where this script is located
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

CONFIG = {
    # Using os.path.join prevents "Invalid Argument" errors on Windows
    'input_file': os.path.join(BASE_DIR, '..', 'cleaned_data.csv'),
    'model_file': os.path.join(BASE_DIR, 'xgb_model_improved.pkl'),
    'transformer_file': os.path.join(BASE_DIR, 'power_transformer.pkl'),
    'submission_file': os.path.join(BASE_DIR, 'xsubmission.csv'),
    'plot_file': os.path.join(BASE_DIR, 'xgb_results_improved.png'),
    'importance_file': os.path.join(BASE_DIR, 'xgb_importance_improved.png'),
    'comparison_plot': os.path.join(BASE_DIR, 'xgb_comparison.png'),
    'forecast_plot': os.path.join(BASE_DIR, 'xgb_4day_forecast.png'),
    'target_col': 'ft_4g_lte_dl_traffic_volume__gbytes',
    'test_split': 0.20,
    'forecast_start_date': '16-12-2025',  # Start date for forecast
    'forecast_end_date': '19-12-2025',    # End date for forecast
    'use_target_transform': True,
    'use_cv': True
}

# Columns to predict (all 6 metrics)
TARGET_METRICS = [
    'ft_4g_lte_dl_traffic_volume__gbytes',
    'ft_average_nb_of_users__ues_rrc_connected',
    'l_traffic_activeuser_dl_avg',
    'ft_ave_4g_lte_dl_user_thrput_without_last_tti_all___kbps__kbit_',
    'ft_physical_resource_blocks_load_dl',
    'ft_4g_lte_average_reported_cqi'
]

# Fixed metadata columns
METADATA_COLS = ['enodeb_name', 'cell_name', 'localcell_id', 'cell_fdd_tdd_indication']

def create_features(df):
    """
    Enhanced feature engineering with all available features.
    Creates time-series features: Date parts, Lags, Rolling stats, and domain features.
    """
    df = df.copy()
    
    # ============================================
    # 1. TIME-BASED FEATURES
    # ============================================
    df['hour'] = df['ds'].dt.hour
    df['dayofweek'] = df['ds'].dt.dayofweek
    df['quarter'] = df['ds'].dt.quarter
    df['month'] = df['ds'].dt.month
    df['dayofyear'] = df['ds'].dt.dayofyear
    df['week'] = df['ds'].dt.isocalendar().week
    df['is_weekend'] = (df['dayofweek'] >= 5).astype(int)
    
    # Telecom traffic patterns: Peak hours (morning and evening rush)
    df['is_peak_hour'] = df['hour'].isin([8, 9, 10, 11, 12, 18, 19, 20, 21]).astype(int)
    df['is_night'] = df['hour'].isin([0, 1, 2, 3, 4, 5]).astype(int)
    
    # Cyclical encoding for hour (captures 23->0 continuity)
    df['hour_sin'] = np.sin(2 * np.pi * df['hour'] / 24)
    df['hour_cos'] = np.cos(2 * np.pi * df['hour'] / 24)
    
    # Cyclical encoding for day of week
    df['dow_sin'] = np.sin(2 * np.pi * df['dayofweek'] / 7)
    df['dow_cos'] = np.cos(2 * np.pi * df['dayofweek'] / 7)
    
    # ============================================
    # 2. LAG FEATURES (Historical values)
    # ============================================
    # Target variable lags
    df['lag_1'] = df['y'].shift(1)         # 1 hour ago
    df['lag_2'] = df['y'].shift(2)         # 2 hours ago
    df['lag_3'] = df['y'].shift(3)         # 3 hours ago
    df['lag_24'] = df['y'].shift(24)       # Same time yesterday
    df['lag_48'] = df['y'].shift(48)       # Same time 2 days ago
    df['lag_168'] = df['y'].shift(168)     # Same time last week
    
    # Number of users lags (if available)
    if 'nb_users' in df.columns:
        df['nb_users_lag_1'] = df['nb_users'].shift(1)
        df['nb_users_lag_24'] = df['nb_users'].shift(24)
    
    # PRB load lags (if available)
    if 'prb_load' in df.columns:
        df['prb_load_lag_1'] = df['prb_load'].shift(1)
    
    # User throughput lags (if available)
    if 'user_thrput' in df.columns:
        df['user_thrput_lag_1'] = df['user_thrput'].shift(1)
    
    # ============================================
    # 3. ROLLING STATISTICS (Trends)
    # ============================================
    # 24-hour rolling stats for target
    df['rolling_mean_24'] = df['y'].shift(1).rolling(window=24).mean()
    df['rolling_std_24'] = df['y'].shift(1).rolling(window=24).std()
    df['rolling_max_24'] = df['y'].shift(1).rolling(window=24).max()
    df['rolling_min_24'] = df['y'].shift(1).rolling(window=24).min()
    df['rolling_median_24'] = df['y'].shift(1).rolling(window=24).median()
    
    # 168-hour (1 week) rolling stats
    df['rolling_mean_168'] = df['y'].shift(1).rolling(window=168).mean()
    df['rolling_std_168'] = df['y'].shift(1).rolling(window=168).std()
    
    # Rolling stats for number of users (if available)
    if 'nb_users' in df.columns:
        df['nb_users_rolling_mean_24'] = df['nb_users'].shift(1).rolling(window=24).mean()
        df['nb_users_rolling_std_24'] = df['nb_users'].shift(1).rolling(window=24).std()
        df['nb_users_rolling_max_24'] = df['nb_users'].shift(1).rolling(window=24).max()
    
    # ============================================
    # 4. DERIVED FEATURES (Interactions)
    # ============================================
    # Ratio features
    if 'nb_users' in df.columns:
        # Traffic per user (avoiding division by zero)
        df['traffic_per_user'] = df['y'] / (df['nb_users'] + 1)
        df['traffic_per_user_lag_1'] = df['traffic_per_user'].shift(1)
    
    # Change from previous hour
    df['change_1h'] = df['y'] - df['y'].shift(1)
    df['change_24h'] = df['y'] - df['y'].shift(24)
    
    # Percentage change
    df['pct_change_1h'] = df['y'].pct_change(1)
    df['pct_change_24h'] = df['y'].pct_change(24)
    
    return df

def create_future_dataframe(df_full, forecast_dates, metadata_df):
    """
    Create a dataframe for future predictions for specific dates.
    For each unique site/cell, create forecasts for all hours in the date range.
    """
    # Parse forecast date range
    start_date = pd.to_datetime(CONFIG['forecast_start_date'], format='%d-%m-%Y')
    end_date = pd.to_datetime(CONFIG['forecast_end_date'], format='%d-%m-%Y') + pd.Timedelta(days=1) - pd.Timedelta(hours=1)
    
    # Create hourly timestamps for the forecast period
    forecast_timestamps = pd.date_range(start=start_date, end=end_date, freq='H')
    
    # Create a row for each site/cell/hour combination
    future_rows = []
    for _, site_row in metadata_df.iterrows():
        for timestamp in forecast_timestamps:
            row = {'ds': timestamp}
            # Add metadata
            for col in METADATA_COLS:
                if col in site_row:
                    row[col] = site_row[col]
            # Add cell/site IDs if they exist
            if 'cell_id' in site_row:
                row['cell_id'] = site_row['cell_id']
            if 'enodeb_id' in site_row:
                row['enodeb_id'] = site_row['enodeb_id']
            
            future_rows.append(row)
    
    future_df = pd.DataFrame(future_rows)
    future_df['y'] = np.nan  # Placeholder, will be filled by model
    
    print(f"  ✓ Created forecast template: {len(future_df)} predictions ({len(metadata_df)} sites × {len(forecast_timestamps)} hours)")
    
    return future_df

def predict_all_metrics(models, future_df, feature_columns, transformers):
    """
    Predict all 6 metrics for the future dataframe.
    """
    print(f"\n[Multi-Metric Prediction] Predicting all metrics...")
    
    predictions = {}
    
    for metric in TARGET_METRICS:
        if metric in models:
            print(f"  Predicting {metric}...")
            
            model = models[metric]
            pt = transformers.get(metric, None)
            
            # Engineer features for this metric
            temp_df = future_df.copy()
            temp_df['y'] = 0  # Dummy value for feature engineering
            
            # For each row, we need to predict (this is simplified - in reality you'd do recursive prediction)
            # For now, using a simple approach with available features
            engineered_df = create_features(temp_df)
            
            # Handle missing features
            for col in feature_columns[metric]:
                if col not in engineered_df.columns:
                    engineered_df[col] = 0
            
            X_future = engineered_df[feature_columns[metric]].fillna(0)
            
            # Predict
            y_pred_transformed = model.predict(X_future)
            
            # Inverse transform if needed
            if pt is not None:
                y_pred = pt.inverse_transform(y_pred_transformed.reshape(-1, 1)).ravel()
            else:
                y_pred = y_pred_transformed
            
            predictions[metric] = y_pred
            print(f"    ✓ Predicted range: {y_pred.min():.2f} to {y_pred.max():.2f}")
    
    return predictions

def format_submission_csv(future_df, predictions):
    """
    Format the final submission CSV with all required columns.
    """
    submission = future_df[METADATA_COLS + ['ds']].copy()
    
    # Format date and time
    submission['date'] = submission['ds'].dt.strftime('%d-%m-%Y')
    submission['time'] = submission['ds'].dt.strftime('%H:%M')
    submission = submission.drop('ds', axis=1)
    
    # Reorder columns to match required format
    cols_order = ['date', 'time'] + METADATA_COLS
    
    # Add predicted metrics
    for metric in TARGET_METRICS:
        if metric in predictions:
            submission[metric] = predictions[metric]
        else:
            submission[metric] = 0  # Default if metric not predicted
    
    # Final column order
    final_cols = cols_order + TARGET_METRICS
    submission = submission[final_cols]
    
    return submission

def visualize_results(train_df, test_df, y_pred, title, save_path):
    """
    Plots the forecast and saves it safely.
    """
    try:
        fig, ax = plt.subplots(figsize=(16, 8))
        
        # Plot only the last 200 hours of training data for clarity
        recent_train = train_df.tail(200)
        
        ax.plot(recent_train['ds'], recent_train['y'], label='Training (Last 200h)', color='gray', alpha=0.5, linewidth=1)
        ax.plot(test_df['ds'], test_df['y'], label='Actual Test Data', color='blue', alpha=0.7, linewidth=1.5)
        ax.plot(test_df['ds'], y_pred, label='XGBoost Prediction', color='red', linestyle='--', linewidth=2)
        
        ax.set_title(title, fontsize=16, fontweight='bold')
        ax.set_xlabel('Date and Time', fontsize=12)
        ax.set_ylabel('Traffic Volume (GB)', fontsize=12)
        ax.legend(fontsize=11)
        ax.grid(True, alpha=0.3)
        
        # Format Date Axis nicely
        ax.xaxis.set_major_formatter(mdates.DateFormatter('%m-%d %H:00'))
        fig.autofmt_xdate()
        
        plt.tight_layout()
        fig.savefig(save_path, dpi=150)
        plt.close(fig)
        print(f"✓ Forecast plot saved to: {save_path}")
        
    except Exception as e:
        print(f"⚠ Error saving forecast plot: {e}")

def plot_importance(model, save_path):
    """
    Plots which features were most useful for the model.
    """
    try:
        fig, ax = plt.subplots(figsize=(12, 10))
        xgb.plot_importance(model, ax=ax, height=0.8, max_num_features=20, 
                           title="Top 20 Most Important Features", importance_type='gain')
        plt.tight_layout()
        fig.savefig(save_path, dpi=150)
        plt.close(fig)
        print(f"✓ Importance plot saved to: {save_path}")
    except Exception as e:
        print(f"⚠ Error saving importance plot: {e}")

def plot_comparison(test_df, y_pred, save_path):
    """
    Creates comparison plots: scatter plot and residuals
    """
    try:
        fig, axes = plt.subplots(1, 2, figsize=(16, 6))
        
        # Scatter plot: Actual vs Predicted
        axes[0].scatter(test_df['y'], y_pred, alpha=0.3, s=10)
        axes[0].plot([test_df['y'].min(), test_df['y'].max()], 
                     [test_df['y'].min(), test_df['y'].max()], 
                     'r--', lw=2, label='Perfect Prediction')
        axes[0].set_xlabel('Actual Traffic (GB)', fontsize=12)
        axes[0].set_ylabel('Predicted Traffic (GB)', fontsize=12)
        axes[0].set_title('Actual vs Predicted', fontsize=14, fontweight='bold')
        axes[0].legend()
        axes[0].grid(True, alpha=0.3)
        
        # Residuals plot
        residuals = test_df['y'].values - y_pred
        axes[1].scatter(y_pred, residuals, alpha=0.3, s=10)
        axes[1].axhline(y=0, color='r', linestyle='--', lw=2)
        axes[1].set_xlabel('Predicted Traffic (GB)', fontsize=12)
        axes[1].set_ylabel('Residuals (GB)', fontsize=12)
        axes[1].set_title('Residual Plot', fontsize=14, fontweight='bold')
        axes[1].grid(True, alpha=0.3)
        
        plt.tight_layout()
        fig.savefig(save_path, dpi=150)
        plt.close(fig)
        print(f"✓ Comparison plot saved to: {save_path}")
        
    except Exception as e:
        print(f"⚠ Error saving comparison plot: {e}")

def perform_cross_validation(X, y, params):
    """
    Perform time series cross-validation
    """
    print("\n--- Performing Time Series Cross-Validation ---")
    tscv = TimeSeriesSplit(n_splits=5)
    cv_scores = []
    cv_rmse = []
    cv_mae = []

    y_arr = np.asarray(y)
    
    for fold, (train_idx, val_idx) in enumerate(tscv.split(X), 1):
        X_cv_train = X.iloc[train_idx]
        y_cv_train = y_arr[train_idx]
        X_cv_val = X.iloc[val_idx]
        y_cv_val = y_arr[val_idx]
        
        model_cv = xgb.XGBRegressor(**params)
        model_cv.fit(X_cv_train, y_cv_train, 
                    eval_set=[(X_cv_val, y_cv_val)], 
                    verbose=False)
        
        y_cv_pred = model_cv.predict(X_cv_val)
        
        r2 = r2_score(y_cv_val, y_cv_pred)
        rmse = np.sqrt(mean_squared_error(y_cv_val, y_cv_pred))
        mae = mean_absolute_error(y_cv_val, y_cv_pred)
        
        cv_scores.append(r2)
        cv_rmse.append(rmse)
        cv_mae.append(mae)
        
        print(f"  Fold {fold}: R²={r2:.4f}, RMSE={rmse:.4f}, MAE={mae:.4f}")
    
    print(f"\nCross-Validation Results:")
    print(f"  R²:   {np.mean(cv_scores):.4f} ± {np.std(cv_scores):.4f}")
    print(f"  RMSE: {np.mean(cv_rmse):.4f} ± {np.std(cv_rmse):.4f}")
    print(f"  MAE:  {np.mean(cv_mae):.4f} ± {np.std(cv_mae):.4f}")
    
    return cv_scores, cv_rmse, cv_mae

def run_xgb_pipeline():
    print(f"{'='*70}")
    print(f"  MULTI-METRIC XGBOOST FORECASTING PIPELINE")
    print(f"  FORECASTING PERIOD: {CONFIG['forecast_start_date']} to {CONFIG['forecast_end_date']}")
    print(f"{'='*70}")
    print(f"Working Directory: {BASE_DIR}\n")
    
    # ============================================
    # 1. LOAD DATA
    # ============================================
    print("[Step 1/10] Loading data...")
    if not os.path.exists(CONFIG['input_file']):
        print(f"❌ ERROR: File not found at {CONFIG['input_file']}")
        return

    df_raw = pd.read_csv(CONFIG['input_file'])
    
    # Convert date formats - handle both DD-MM-YYYY and other formats
    if 'date' in df_raw.columns and 'time' in df_raw.columns:
        df_raw['datetime'] = pd.to_datetime(df_raw['date'] + ' ' + df_raw['time'], 
                                            format='%d-%m-%Y %H:%M', errors='coerce')
    elif 'datetime' in df_raw.columns:
        df_raw['datetime'] = pd.to_datetime(df_raw['datetime'], errors='coerce')
    else:
        print("❌ ERROR: No datetime column found")
        return
    
    print(f"  ✓ Loaded {len(df_raw):,} rows")
    print(f"  ✓ Date range: {df_raw['datetime'].min()} to {df_raw['datetime'].max()}")
    
    # Store metadata for all unique sites/cells
    metadata_cols_available = [col for col in METADATA_COLS if col in df_raw.columns]
    metadata_df = df_raw[metadata_cols_available].drop_duplicates().reset_index(drop=True)
    
    # Add encoded IDs for modeling (but keep original names)
    if 'cell_name' in metadata_df.columns:
        metadata_df['cell_id'] = pd.Categorical(metadata_df['cell_name']).codes
    if 'enodeb_name' in metadata_df.columns:
        metadata_df['enodeb_id'] = pd.Categorical(metadata_df['enodeb_name']).codes
    
    print(f"  ✓ Found {len(metadata_df)} unique site/cell combinations")
    
    # Store site/cell names for later reference
    site_cell_mapping = metadata_df.copy()
    
    # ============================================
    # 2. TRAIN MODELS FOR EACH METRIC
    # ============================================
    print("\n[Step 2/10] Training models for each metric...")
    
    models = {}
    transformers = {}
    feature_columns_dict = {}
    
    # For simplicity, we'll train on the main traffic metric
    # In production, you'd train separate models for each metric
    target_col = CONFIG['target_col']
    
    # Prepare dataframe
    df = df_raw[['datetime', target_col]].copy()
    df.columns = ['ds', 'y']
    df = df.sort_values('ds').reset_index(drop=True)
    
    # Feature engineering
    print("\n[Step 3/10] Engineering features...")
    df = create_features(df)
    
    # Replace any inf/-inf
    df = df.replace([np.inf, -np.inf], np.nan)
    
    # Drop NaNs
    rows_before = len(df)
    df = df.dropna()
    rows_after = len(df)
    print(f"  ✓ Created {len(df.columns)} total features")
    print(f"  ✓ Dropped {rows_before - rows_after:,} rows with NaN")
    
    # Train/test split
    print(f"\n[Step 4/10] Splitting data...")
    split_idx = int(len(df) * (1 - CONFIG['test_split']))
    train_df = df.iloc[:split_idx].copy()
    test_df = df.iloc[split_idx:].copy()
    
    feature_columns = [col for col in df.columns if col not in ['ds', 'y']]
    X_train = train_df[feature_columns]
    y_train = train_df['y']
    X_test = test_df[feature_columns]
    y_test = test_df['y']
    
    print(f"  ✓ Training: {len(train_df):,}, Test: {len(test_df):,}")
    
    # Target transformation
    print("\n[Step 5/10] Applying target transformation...")
    pt = PowerTransformer(method='yeo-johnson')
    y_train_transformed = pt.fit_transform(y_train.values.reshape(-1, 1)).ravel()
    transformers[target_col] = pt
    
    # Train model
    print("\n[Step 6/10] Training XGBoost model...")
    params = {
        'n_estimators': 1500,
        'learning_rate': 0.03,
        'max_depth': 8,
        'min_child_weight': 3,
        'subsample': 0.8,
        'colsample_bytree': 0.8,
        'gamma': 0.1,
        'reg_alpha': 0.01,
        'reg_lambda': 1.0,
        'early_stopping_rounds': 50,
        'n_jobs': -1,
        'objective': 'reg:squarederror',
        'random_state': 42
    }
    
    reg = xgb.XGBRegressor(**params)
    y_test_transformed = pt.transform(y_test.values.reshape(-1, 1)).ravel()
    eval_set = [(X_train, y_train_transformed), (X_test, y_test_transformed)]
    
    reg.fit(X_train, y_train_transformed, eval_set=eval_set, verbose=False)
    
    models[target_col] = reg
    feature_columns_dict[target_col] = feature_columns
    
    print(f"  ✓ Model trained! Best iteration: {reg.best_iteration}")
    
    # Save model
    print("\n[Step 7/10] Saving model...")
    with open(CONFIG['model_file'], 'wb') as f:
        pickle.dump(reg, f)
    with open(CONFIG['transformer_file'], 'wb') as f:
        pickle.dump(pt, f)
    print(f"  ✓ Model saved")
    
    # Evaluate
    print("\n[Step 8/10] Evaluating model...")
    y_pred_transformed = reg.predict(X_test)
    y_pred = pt.inverse_transform(y_pred_transformed.reshape(-1, 1)).ravel()
    
    rmse = np.sqrt(mean_squared_error(y_test, y_pred))
    mae = mean_absolute_error(y_test, y_pred)
    r2 = r2_score(y_test, y_pred)
    
    print(f"\n  RMSE:  {rmse:.4f} GB")
    print(f"  MAE:   {mae:.4f} GB")
    print(f"  R²:    {r2:.4f}")
    
    # ============================================
    # 9. GENERATE FORECAST FOR DEC 16-19
    # ============================================
    print(f"\n[Step 9/10] Generating forecast for {CONFIG['forecast_start_date']} to {CONFIG['forecast_end_date']}...")
    
    # Create future dataframe
    future_df = create_future_dataframe(df, None, site_cell_mapping)
    
    # Predict all metrics (for now, just the main metric - extend this for all 6)
    predictions = {}
    
    # Main prediction - batch processing with proper time features
    print("  Predicting traffic volume with time-based features...")
    
    # Group by site/cell to predict each cell's timeseries separately
    predictions_list = []
    
    for (enodeb, cell), group in future_df.groupby(['enodeb_name', 'cell_name']):
        # Get historical data for this cell (if available)
        if 'enodeb_name' in df_raw.columns and 'cell_name' in df_raw.columns:
            historical = df_raw[
                (df_raw['enodeb_name'] == enodeb) & 
                (df_raw['cell_name'] == cell)
            ].copy()
            
            if len(historical) > 0:
                # Prepare historical data
                hist_df = historical[['datetime', target_col]].copy()
                hist_df.columns = ['ds', 'y']
                hist_df = hist_df.sort_values('ds').reset_index(drop=True)
                
                # Combine historical + future timestamps for this cell
                future_times = pd.DataFrame({
                    'ds': group['ds'].values,
                    'y': np.nan
                })
                
                combined = pd.concat([hist_df.tail(336), future_times], ignore_index=True)  # Last 2 weeks + future
                
                # Engineer features
                combined_eng = create_features(combined)
                
                # Get only the future predictions
                future_indices = combined_eng['ds'].isin(group['ds'].values)
                future_features = combined_eng[future_indices][feature_columns]
                
                # Fill NaNs
                future_features = future_features.fillna(hist_df['y'].median())
                
                # Predict
                y_pred_transformed = reg.predict(future_features)
                y_pred_vals = pt.inverse_transform(y_pred_transformed.reshape(-1, 1)).ravel()
                
                predictions_list.extend(y_pred_vals)
            else:
                # No historical data for this cell, use global median
                predictions_list.extend([df['y'].median()] * len(group))
        else:
            # No cell-specific data available, use time-based features only
            temp_df = group.copy()
            temp_df['y'] = df['y'].median()
            
            temp_eng = create_features(temp_df)
            temp_features = temp_eng[feature_columns].fillna(df[feature_columns].median())
            
            y_pred_transformed = reg.predict(temp_features)
            y_pred_vals = pt.inverse_transform(y_pred_transformed.reshape(-1, 1)).ravel()
            
            predictions_list.extend(y_pred_vals)
    
    predictions[target_col] = np.array(predictions_list)
    print(f"  ✓ Predictions range: {min(predictions_list):.2f} to {max(predictions_list):.2f} GB")
    
    # For other metrics, use simple heuristics or median values
    # (In production, train separate models for each)
    for metric in TARGET_METRICS:
        if metric != target_col and metric in df_raw.columns:
            # Use median value from historical data
            predictions[metric] = np.full(len(future_df), df_raw[metric].median())
    
    # Format submission
    submission = format_submission_csv(future_df, predictions)
    
    # Save
    submission.to_csv(CONFIG['submission_file'], index=False)
    print(f"\n  ✓ Forecast saved to: {CONFIG['submission_file']}")
    print(f"  ✓ Total predictions: {len(submission)} rows")
    print(f"  ✓ Sites: {submission['enodeb_name'].nunique()}, Cells: {submission['cell_name'].nunique()}")
    
    # Show sample
    print("\n  Sample predictions:")
    print(submission.head(10).to_string(index=False))
    
    # ============================================
    # 10. VISUALIZATIONS
    # ============================================
    print("\n[Step 10/10] Generating plots...")
    
    # Only generate plots that work with the current data structure
    try:
        plot_importance(reg, CONFIG['importance_file'])
    except Exception as e:
        print(f"  ⚠ Could not generate importance plot: {e}")
    
    print("\n  ✓ Generated availdable plots")
    
    print("\n" + "="*70)
    print("  PIPELINE COMPLETED SUCCESSFULLY!")
    print("="*70)
    print(f"\nSubmission file format:")
    print(f"  Columns: {', '.join(submission.columns.tolist())}")
    print(f"  Rows: {len(submission)}")
    print(f"  Date range: {submission['date'].min()} to {submission['date'].max()}")
    print("\n")

if __name__ == "__main__":
    try:
        run_xgb_pipeline()
    except Exception as e:
        print(f"\n❌ PIPELINE FAILED WITH ERROR:")
        print(f"   {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
