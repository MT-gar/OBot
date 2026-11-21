import re
import subprocess,os,json,threading,queue,time,datetime
from pathlib import Path
base=Path('/root/.local/share/private-computer-dsh');state=Path('/root/.local/state/private-computer-dsh-acp');workspace=base/'probe-workspace';out=Path('/mnt/d/文件/项目/Bot/.local/evidence/acp-minimal-request.json')
node=str(base/'node_modules/node/bin/node');entry=str(base/'node_modules/@deepseek-ai/dsh/lib/bin.js')
key=(Path('/root/.local/state/private-computer-p0/model-key').read_text()).strip();env=os.environ.copy();env['PATH']=str(Path(node).parent)+':'+env.get('PATH','');env['DSH_HOME']=str(state);env['DSH_TELEMETRY_DISABLED']='1';env['XINGCHI_API_KEY']=key
result={'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'client':'real @deepseek-ai/dsh ACP','version':'0.2.2-rc.3','model':'gpt-6.1-sol','requestedEffort':'max','ok':False,'toolCalls':0,'permissionRequests':0,'stage':'launch'}
def save():out.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
save();process=None;messages=queue.Queue();events=[];diagnostics=[];seq=0;session=None;request_sent=False
try:
 process=subprocess.Popen([node,entry,'--profile','acp','--patch',str(state/'probe.patch.json')],cwd=workspace,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
 def stdout_reader():
  for line in process.stdout:
   try:messages.put(json.loads(line))
   except Exception:diagnostics.append(line[:2000])
  messages.put({'eof':True})
 def stderr_reader():
  for line in process.stderr:
   diagnostics.append(line[:3000])
 threading.Thread(target=stdout_reader,daemon=True).start();threading.Thread(target=stderr_reader,daemon=True).start()
 def send(value):process.stdin.write(json.dumps(value)+'\n');process.stdin.flush()
 def rpc(method,params,timeout=40):
  global seq
  seq+=1;rid=seq;send({'jsonrpc':'2.0','id':rid,'method':method,'params':params});deadline=time.monotonic()+timeout
  while time.monotonic()<deadline:
   try:m=messages.get(timeout=min(1,max(.01,deadline-time.monotonic())))
   except queue.Empty:
    if process.poll() is not None:raise RuntimeError('dsh_process_exited')
    continue
   if m.get('id')==rid and ('result' in m or 'error' in m):
    if 'error' in m:
     e=json.dumps(m['error']);diagnostics.append(e);result['rpcErrorCode']=m['error'].get('code');result['rpcErrorMessage']=re.sub(r'(?:sk-[A-Za-z0-9_-]+|Bearer\s+\S+)','[redacted]',str(m['error'].get('message','')).replace(key,'[redacted]'))[:1200];raise RuntimeError('acp_rpc_failed')
    return m['result']
   if m.get('method')=='session/update':
    update=m.get('params',{}).get('update',{});kind=update.get('sessionUpdate','')
    if kind=='agent_message_chunk':events.append(update.get('content',{}).get('text',''))
    if kind in ['tool_call','tool_call_update']:result['toolCalls']+=1
   elif m.get('method')=='session/request_permission':
    result['permissionRequests']+=1;send({'jsonrpc':'2.0','id':m['id'],'result':{'outcome':{'outcome':'cancelled'}}})
   elif 'id' in m and m.get('method'):send({'jsonrpc':'2.0','id':m['id'],'error':{'code':-32601,'message':'Unsupported client method'}})
   elif m.get('eof'):raise RuntimeError('dsh_stdout_closed')
  raise TimeoutError('acp_timeout')
 result['stage']='initialize';save();init=rpc('initialize',{'protocolVersion':1,'clientCapabilities':{},'clientInfo':{'name':'private-computer-acp-probe','version':'0.0.1'}});result['agentInfo']=init.get('agentInfo');result['protocolVersion']=init.get('protocolVersion')
 result['stage']='session/new';save();new=rpc('session/new',{'cwd':str(workspace),'mcpServers':[]});session=new['sessionId'];options=new.get('configOptions',[]);effort=next((x for x in options if x.get('id')=='reasoning_effort'),None)
 if not effort:raise RuntimeError('reasoning_option_missing')
 def flatten(values):
  entries=[]
  for value in values:
   if 'options' in value:entries.extend(flatten(value['options']))
   else:entries.append(value)
  return entries
 choices=flatten(effort.get('options',[]));chosen=next((x['value'] for x in choices if x.get('value')=='max'),None)
 if chosen is None:raise RuntimeError('max_not_advertised')
 result['stage']='select-max';save();selected=rpc('session/set_config_option',{'sessionId':session,'configId':'reasoning_effort','value':chosen});result['selectedEffort']='max'
 result['stage']='minimal-prompt';request_sent=True;save();final=rpc('session/prompt',{'sessionId':session,'prompt':[{'type':'text','text':'Reply exactly READY. This is a single connection test. Do not use any tools, files, network actions or subagents.'}]},120)
 text=''.join(events).strip();result['stopReason']=final.get('stopReason');result['readyAnswer']=text=='READY';result['ok']=text=='READY' and final.get('stopReason')=='end_turn' and result['toolCalls']==0 and result['permissionRequests']==0;result['stage']='completed' if result['ok'] else 'unexpected_completion'
except Exception as error:
 result['stageError']=type(error).__name__;result['localFailure']=str(error) if str(error) in ['dsh_process_exited','acp_rpc_failed','dsh_stdout_closed','acp_timeout','reasoning_option_missing','max_not_advertised'] else 'probe_failed'
 raw='\n'.join(diagnostics).replace(key,'[redacted]');result['clientNotAllowed']='client_not_allowed' in raw;result['authenticationRejected']=('401' in raw or 'INVALID_CREDENTIAL' in raw);result['diagnosticCodes']=[code for code in ['UNKNOWN_MODEL','MISSING_CREDENTIAL','REQUEST_HEADERS','LLM_ERROR','TRANSPORT','ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND','StartupError'] if code in raw]
 # Startup diagnostics are only safe after removing credentials and common auth patterns.
 if not request_sent:
  clean=re.sub(r'(?:sk-[A-Za-z0-9_-]+|Bearer\s+\S+)','[redacted]',raw)
  result['startupDiagnostics']=clean[-5000:]
finally:
 if process:
  if session and process.poll() is None:
   try:rpc('session/close',{'sessionId':session},10)
   except Exception:pass
  if process.stdin:
   try:process.stdin.close()
   except Exception:pass
  try:process.wait(timeout=12)
  except subprocess.TimeoutExpired:
   process.terminate()
   try:process.wait(timeout=6)
   except subprocess.TimeoutExpired:process.kill();process.wait()
  result['processExitCode']=process.returncode
 result['requestSubmitted']=request_sent;result['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();key='';env.pop('XINGCHI_API_KEY',None);save()
