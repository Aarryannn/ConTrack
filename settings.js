const KEY="reminderSettings";
const DEFAULT={intervals:[1440,60,10,30],customMinutes:30,chrome:true,calendar:true,tasks:true};
const $=id=>document.getElementById(id);
const get=()=>new Promise(resolve=>chrome.storage.local.get(KEY,r=>resolve(r[KEY])));
const send=msg=>new Promise((resolve,reject)=>{
  let settled=false;
  const timer=setTimeout(()=>{if(!settled){settled=true;reject(Error("ConTrac did not respond. Reload the extension at chrome://extensions and try again."));}},15000);
  chrome.runtime.sendMessage(msg,r=>{
    if(settled)return;
    settled=true;clearTimeout(timer);
    const err=chrome.runtime.lastError;
    if(err)reject(Error(err.message));
    else if(!r?.success)reject(Error(r?.error||"Extension request failed"));
    else resolve(r);
  });
});
async function load(){const saved=await get();const s={...DEFAULT,...(saved||{})};document.querySelectorAll(".reminderInterval").forEach(el=>el.checked=(s.intervals||[]).includes(Number(el.value)));$("customMinutes").value=s.customMinutes??30;$("chromeEnabled").checked=s.chrome!==false;$("calendarEnabled").checked=s.calendar===true;$("tasksEnabled").checked=s.tasks===true;}
$("saveSettings").addEventListener("click",async()=>{const intervals=[...document.querySelectorAll(".reminderInterval:checked")].map(x=>Number(x.value));const custom=Number($("customMinutes").value);if($("customMinutes").value.trim()&&(!Number.isInteger(custom)||custom<1||custom>40320)){$("statusMessage").textContent="Enter a custom interval between 1 and 40,320 minutes.";return}if(custom&&!intervals.includes(custom))intervals.push(custom);if(!intervals.length){$("statusMessage").textContent="Choose at least one reminder interval.";return}const settings={intervals:[...new Set(intervals)].sort((a,b)=>b-a),customMinutes:custom||null,chrome:$("chromeEnabled").checked,calendar:$("calendarEnabled").checked,tasks:$("tasksEnabled").checked};$("saveSettings").disabled=true;$("statusMessage").textContent="Saving your preferences…";try{await send({type:"SAVE_REMINDER_SETTINGS",settings});$("statusMessage").textContent="All set — your reminder preferences have been saved."; }catch(e){$("statusMessage").textContent=e.message}finally{$("saveSettings").disabled=false}});
load().catch(e=>$("statusMessage").textContent=e.message);


const demoButton=$("demoNotificationBtn");
const cleanupDemoButton=$("cleanupDemoBtn");
function renderDemoState(state){
  if(!state)return;
  for(const key of ["chrome","calendar","tasks"]){
    const item=state.checks?.[key]; if(!item)continue;
    const id=key[0].toUpperCase()+key.slice(1),card=$("test"+id),badge=$("test"+id+"State"),detail=$("test"+id+"Detail");
    card?.classList.remove("passed","failed","skipped","pending");card?.classList.add(item.status||"pending");
    if(badge)badge.textContent=(item.status||"pending").toUpperCase();
    if(detail)detail.textContent=item.detail||"No diagnostic detail available.";
  }
  const summary=state.status==="passed"?"All enabled channels passed.":state.status==="partial"?"Some channels passed. Review the failed or skipped checks.":state.status==="failed"?"The system check failed. Review each channel for the cause.":state.status==="no-tests"?"No delivery channels are enabled. Turn on at least one channel and run the check again.":"System check in progress…";
  $("demoStatus").textContent=`${summary}${state.accountEmail?` Verified account: ${state.accountEmail}.`:""}`;
  $("demoStatus").classList.toggle("auth-success",state.status==="passed");
  $("demoStatus").classList.toggle("auth-warning",state.status==="failed"||state.status==="partial");
}
if(demoButton){demoButton.addEventListener("click",async()=>{
  demoButton.disabled=true;demoButton.innerHTML='Running checks <span>…</span>';
  $("demoStatus").textContent="Checking enabled channels. This can take a few seconds…";
  try{const result=await send({type:"SCHEDULE_DEMO_NOTIFICATION"});renderDemoState(result.state);}
  catch(error){$("demoStatus").textContent=`System check could not run: ${error.message}`;$("demoStatus").classList.add("auth-warning");}
  finally{demoButton.disabled=false;demoButton.innerHTML='Run system check <span>→</span>';}
});}
cleanupDemoButton?.addEventListener("click",async()=>{
  cleanupDemoButton.disabled=true;cleanupDemoButton.textContent="Cleaning…";
  try{const result=await send({type:"CLEANUP_DEMO_ARTIFACTS"});$("demoStatus").textContent=result.message;$("demoStatus").classList.toggle("auth-warning",!result.success);}
  catch(error){$("demoStatus").textContent=error.message;$("demoStatus").classList.add("auth-warning");}
  finally{cleanupDemoButton.disabled=false;cleanupDemoButton.textContent="Clean up test items";}
});
send({type:"GET_DEMO_STATUS"}).then(({state})=>renderDemoState(state)).catch(()=>{});

async function refreshGoogleAccountStatus(){
  const status=$("googleAccountStatus");
  const detail=$("googleAccountDetail");
  const disconnect=$("googleDisconnectBtn");
  const connect=$("googleReconnectBtn");
  try{
    const result=await send({type:"GET_STATUS"});
    status.textContent=result.connected?`Connected · ${result.accountEmail||"Google account verified"}`:"No Google account connected";
    detail.textContent=result.connected
      ? `Authenticated as ${result.accountName||result.accountEmail||"Google user"}. Calendar and Tasks sync follow your delivery preferences.`
      : "Connect Google to authorize Calendar and Tasks. Your account email will be verified after sign-in.";
    const sync=result.syncStatus;
    $("googleSyncSummary").textContent=result.connected
      ? (sync?.errors?.length?`Connected, but last sync reported: ${sync.errors.join(" · ")}`:sync?.completedAt?`Last sync checked ${new Date(sync.completedAt).toLocaleString()}.`:"Account verified. Waiting for the first sync result.")
      : "Disconnected. No Google API sync should run until you connect again.";
    disconnect.disabled=false;
    connect.textContent=result.connected?"Reconnect / switch account":"Connect Google";
  }catch(error){
    status.textContent="Unable to read Google status";
    detail.textContent=error.message;
    disconnect.disabled=true;
  }
}
$("googleReconnectBtn")?.addEventListener("click",async()=>{
  const button=$("googleReconnectBtn");
  button.disabled=true;
  $("googleAccountMessage").textContent="Opening Google sign-in…";
  try{
    const result=await send({type:"GOOGLE_CONNECT"});
    const warningText=result.warnings?.length?` Note: ${result.warnings.join(" | ")}`:"";
    $("googleAccountMessage").textContent=result.authenticated
      ?`Verified ${result.account?.email||"Google account"}. Contest synchronization is running in the background.${warningText}`
      :"Google sign-in did not complete.";
    await refreshGoogleAccountStatus();
  }catch(error){
    $("googleAccountMessage").textContent=error.message;
  }finally{button.disabled=false;}
});
$("googleDisconnectBtn")?.addEventListener("click",async()=>{
  const button=$("googleDisconnectBtn");
  button.disabled=true;
  $("googleAccountMessage").textContent="Disconnecting Google account…";
  try{
    const result=await send({type:"GOOGLE_DISCONNECT"});
    const warningText=result.warnings?.length?` Note: ${result.warnings.join(" | ")}`:"";
    $("googleAccountMessage").textContent=`ConTrac is disconnected and its cached Google authorization has been cleared where Chrome allowed it. Existing Calendar events and Tasks remain in your Google account. You can now connect again.${warningText}`;
    await refreshGoogleAccountStatus();
  }catch(error){
    $("googleAccountMessage").textContent=error.message;
    button.disabled=false;
  }
});
refreshGoogleAccountStatus();

send({type:"GET_DIAGNOSTICS"}).then(({reminders,googleSync,googleConnected,googleAccountEmail,notificationPermission})=>{
  const bits=[];
  bits.push(reminders?`${reminders.scheduledAlarmCount} Chrome reminder alarm(s) scheduled for ${reminders.selectedContestCount} selected contest(s).`:"Reminder schedule has not been calculated yet.");
  bits.push(googleConnected?`Google account connected${googleAccountEmail?` (${googleAccountEmail})`:""}.`:"Google account disconnected.");
  bits.push(`Chrome notification permission: ${notificationPermission || "unknown"}.`);
  if(googleSync){
    bits.push(`Last Google sync: ${new Date(googleSync.completedAt).toLocaleString()}.`);
    if(googleSync.errors?.length)bits.push(`Sync issue: ${googleSync.errors.join(" | ")}`);
  }
  $("statusMessage").textContent=bits.join(" ");
}).catch(()=>{});

chrome.storage.onChanged.addListener((changes,area)=>{
  if(area!=="local")return;
  if(changes.googleIntegration||changes.googleSyncStatus)refreshGoogleAccountStatus();
});
