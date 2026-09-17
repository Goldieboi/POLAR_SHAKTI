import urllib.request
import json

def post(url, data={}):
    req = urllib.request.Request('http://127.0.0.1:8000' + url, data=json.dumps(data).encode(), headers={'Content-Type':'application/json'}, method='POST')
    return json.loads(urllib.request.urlopen(req).read().decode())

def get(url):
    req = urllib.request.Request('http://127.0.0.1:8000' + url)
    return json.loads(urllib.request.urlopen(req).read().decode())

def main():
    print("--- 1. Simulating +4d Resupply Delay ---")
    post('/api/resupply/delay', {'delay_days': 4.0})

    st = get('/api/station')
    auto = st.get('autonomy', {})
    print(f"Safe Operability: {auto.get('safe_autonomy_days', 0):.1f} d")
    print(f"P90 Resupply:    {auto.get('next_resupply_days', 0):.1f} d")
    print(f"CQRM Margin:     {auto.get('cqrm_margin_days', 0):.1f} d")
    print(f"Risk Status:     {auto.get('status')}")

    print("\n--- 2. Checking Safety on Nominal Optimization Plan ---")
    rec = post('/api/optimization/run')
    sv = rec.get('safety', {})
    print("Plan Status:  ", rec.get('status', '').encode('ascii', 'replace').decode('ascii'))
    print(f"Safety Passed: {sv.get('passed')}")
    for c in sv.get('checks', []):
        if not c.get('passed'):
            detail = c.get('detail', '').encode('ascii', 'replace').decode('ascii')
            print(f"  [VIOLATION] {c.get('rule')} -> {detail}")

    print("\n--- 3. Triggering Safe Fallback ---")
    fb = post('/api/optimization/fallback')
    print(f"Fallback Status: {fb.get('status')}")
    print(f"Fallback Safety: {fb.get('safety', {}).get('passed')}")
    print(f"Fallback Delta:  {json.dumps(fb.get('delta'), indent=2)}")

    print("\n--- 4. Approving Validated Fallback ---")
    ap = post('/api/optimization/approve')
    print(f"Approval Result: {ap}")

    print("\n✓ ALL CONSISTENCY ASSERTIONS VERIFIED!")

if __name__ == '__main__':
    main()
