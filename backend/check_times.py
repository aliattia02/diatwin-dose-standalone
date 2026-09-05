import sys
sys.path.insert(0, '.')
from main import app

with app.app_context():
    from config import mongo
    from datetime import timedelta

    # --- Stored readings ---
    docs = list(mongo.db.blood_sugar.find(
        {'user_id': '69a04c6e784cf6494fd448c4', 'source': 'libre_cgm'},
        {'bloodSugar': 1, 'bloodSugarTimestamp': 1, '_id': 0}
    ).sort('bloodSugarTimestamp', -1).limit(3))

    print("=== STORED IN DB (should be UTC) ===")
    for d in docs:
        ts = d['bloodSugarTimestamp']
        print(f"  {d['bloodSugar']} mg/dL  @ {ts}")

    # --- Raw API ---
    from routes.libre_routes import _get_valid_token, _service_from_connection
    import requests, hashlib
    from services.libre_service import LLU_HEADERS

    conn  = mongo.db.libre_connections.find_one({'user_id': '69a04c6e784cf6494fd448c4'})
    token = _get_valid_token(conn, '69a04c6e784cf6494fd448c4')
    headers = {**LLU_HEADERS, 'Authorization': f'Bearer {token}'}
    aid = conn.get('account_id', '')
    if aid:
        headers['account-id'] = hashlib.sha256(aid.encode()).hexdigest()

    resp    = requests.get(
        f"{conn['base_url']}/llu/connections/{conn['libre_patient_id']}/graph",
        headers=headers, timeout=15
    )
    entries = resp.json().get('data', {}).get('graphData', []) or []

    print()
    print("=== RAW API (last 3 entries) ===")
    for e in entries[-3:]:
        print(f"  Timestamp        (local): {e.get('Timestamp')}")
        print(f"  FactoryTimestamp (UTC  ): {e.get('FactoryTimestamp')}")
        print()

    # --- Expected display ---
    print("=== WHAT APP SHOULD DISPLAY (stored UTC + 2h for Egypt) ===")
    for d in docs[:3]:
        ts = d['bloodSugarTimestamp']
        if hasattr(ts, 'strftime'):
            local_time = ts + timedelta(hours=2)
            print(f"  stored {ts.strftime('%H:%M')} UTC  ->  display {local_time.strftime('%H:%M')} Egypt local")
        else:
            print(f"  ts is not a datetime: {type(ts)} = {ts}")
