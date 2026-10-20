#!/usr/bin/env bash
# Usage statistics from the anonymous access log (logs/, see the Caddyfile).
# Usage: ./stats.sh [days]   (default: 30)
set -euo pipefail
cd "$(dirname "$0")"

python3 - "${1:-30}" logs/access*.log* <<'EOF'
import collections, datetime, gzip, json, sys

days = int(sys.argv[1])
since = datetime.date.today() - datetime.timedelta(days=days - 1)

visits = collections.Counter()      # page loads
uses = collections.Counter()        # "Flouter les visages" clicks: worker.js is only fetched then
hosts = collections.Counter()
ffmpeg = limited = errors = 0

for path in sys.argv[2:]:
    opener = gzip.open if path.endswith('.gz') else open
    with opener(path, 'rt') as f:
        for line in f:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            day = datetime.datetime.fromtimestamp(e['ts']).date()
            if day < since:
                continue
            req, status = e.get('request', {}), e.get('status', 0)
            uri = req.get('uri', '').split('?')[0]
            if status == 429:
                limited += 1
            elif status >= 500:
                errors += 1
            if req.get('method') != 'GET' or not (200 <= status < 400):
                continue
            if uri in ('/', '/index.html'):
                visits[day] += 1
                hosts[req.get('host', '?')] += 1
            elif uri == '/worker.js':
                uses[day] += 1
            elif uri == '/vendor/ffmpeg-core/ffmpeg-core.wasm':
                ffmpeg += 1

print(f"Last {days} days (since {since:%d/%m/%Y})\n")
print(f"{'day':<12}{'visits':>8}{'uses':>8}")
for i in range(days):
    day = since + datetime.timedelta(days=i)
    if visits[day] or uses[day]:
        print(f"{day:%d/%m/%Y}  {visits[day]:>8}{uses[day]:>8}")
print(f"{'total':<12}{sum(visits.values()):>8}{sum(uses.values()):>8}\n")
print("Visits by address:")
for host, n in hosts.most_common():
    print(f"  {n:>6}  {host}")
print(f"\nffmpeg.wasm downloads (videos the browser couldn't handle itself; cached 7 days): {ffmpeg}")
print(f"Rate-limited requests: {limited}   Server errors: {errors}")
print("\n'visits' include bots and reloads; 'uses' only count real browsers that started processing.")
EOF
