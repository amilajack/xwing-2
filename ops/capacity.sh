#!/bin/bash
# Run through SSM for 30 minutes while four real browser transports exercise the server.
set -euo pipefail
mkdir -p /var/lib/xwing
python3 - <<'PY'
import json, time, pathlib
samples=[]; start=time.monotonic(); clock=__import__('os').sysconf('SC_CLK_TCK'); previous=None; previous_host=None
for i in range(181):
 unit=__import__('subprocess').check_output(['systemctl','show','xwing','-p','MainPID','--value'],text=True).strip()
 pid=int(unit); stat=pathlib.Path(f'/proc/{pid}/stat').read_text().split(); ticks=int(stat[13])+int(stat[14]); now=time.monotonic()
 mem=dict((line.split(':')[0],int(line.split()[1])) for line in pathlib.Path('/proc/meminfo').read_text().splitlines() if line.split()[1].isdigit())
 cpu=None if previous is None else (ticks-previous[1])/clock/(now-previous[0]); previous=(now,ticks)
 host_stat=list(map(int,pathlib.Path('/proc/stat').read_text().splitlines()[0].split()[1:9])); busy=sum(host_stat[:3])+sum(host_stat[5:8])
 host_cpu=None if previous_host is None else (busy-previous_host[1])/clock/(now-previous_host[0]); previous_host=(now,busy)
 samples.append({'seconds':now-start,'pid':pid,'cpuCores':cpu,'hostCpuCores':host_cpu,'memoryUsedFraction':1-mem['MemAvailable']/mem['MemTotal']})
 pathlib.Path('/var/lib/xwing/capacity.json').write_text(json.dumps(samples))
 if i<180:time.sleep(10)
print(json.dumps({'seconds':samples[-1]['seconds'],'restarts':len(set(s['pid'] for s in samples))-1,'meanCpuCores':sum(s['cpuCores'] or 0 for s in samples[1:])/180,'meanHostCpuCores':sum(s['hostCpuCores'] or 0 for s in samples[1:])/180,'maxMemoryFraction':max(s['memoryUsedFraction'] for s in samples)}))
PY
python3 - <<'PYMETRICS'
import json,subprocess,pathlib
text=subprocess.check_output(['journalctl','-u','xwing','--since','-31 minutes','--no-pager','-o','cat'],text=True)
metrics=[]
for line in text.splitlines():
 try:
  value=json.loads(line)
  if value.get('type')=='metrics':metrics.append(value)
 except ValueError:pass
pathlib.Path('/var/lib/xwing/metrics.json').write_text(json.dumps(metrics))
print(json.dumps({'metricSamples':len(metrics),'maxTickP95Ms':max((x['tickP95Ms'] for x in metrics),default=0),'maxRss':max((x['rss'] for x in metrics),default=0),'maxConnections':max((x['connections'] for x in metrics),default=0),'persistenceFailures':max((x['persistenceFailures'] for x in metrics),default=0),'packetLoss':max((x['inputsLost'] for x in metrics),default=0),'snapshotDrops':max((x['snapshotDrops'] for x in metrics),default=0)}))
PYMETRICS
journalctl -u xwing --since '-31 minutes' --no-pager -o cat | tail -200
