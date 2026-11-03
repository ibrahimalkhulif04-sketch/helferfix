(()=>{
'use strict';
const languages={
 de:{open:'KI-Support',title:'HelferFix Support',intro:'Hallo! Ich helfe dir bei Fragen zur Nutzung von HelferFix.',placeholder:'Deine Frage …',send:'Senden',busy:'Antwort wird erstellt …',failed:'Das hat leider nicht geklappt. Bitte nutze den Support-E-Mail-Link oben.',offline:'Der KI-Support ist noch nicht aktiviert. Bitte nutze bis dahin den Support-E-Mail-Link oben.',close:'Schließen'},
 ar:{open:'الدعم الذكي',title:'دعم HelferFix',intro:'أهلاً بك! أساعدك في الأسئلة المتعلقة باستخدام HelferFix.',placeholder:'اكتب سؤالك…',send:'إرسال',busy:'جارٍ إعداد الرد…',failed:'تعذر إرسال الرسالة. يرجى استخدام رابط بريد الدعم بالأعلى.',offline:'الدعم الذكي لم يتم تفعيله بعد. يرجى استخدام رابط بريد الدعم بالأعلى.',close:'إغلاق'},
 en:{open:'AI Support',title:'HelferFix Support',intro:'Hello! I can help with questions about using HelferFix.',placeholder:'Ask your question…',send:'Send',busy:'Preparing a reply …',failed:'Sorry, that did not work. Please use the Support email link above.',offline:'AI support is not activated yet. Please use the Support email link above.',close:'Close'}
};
const language=()=>{const value=document.querySelector('#language')?.value;return ['de','ar','en'].includes(value)?value:'de';};
let history=[],busy=false;
const style=document.createElement('style');
style.textContent='#hfAiToggle{position:fixed;z-index:9998;inset:auto 18px 18px auto;border:0;border-radius:999px;padding:13px 17px;background:#176b4d;color:#fff;font:700 15px system-ui;box-shadow:0 5px 22px #0003;cursor:pointer}\n#hfAiPanel{position:fixed;z-index:9999;inset:auto 16px 78px auto;width:min(360px,calc(100vw - 28px));height:min(520px,calc(100dvh - 110px));background:#fff;border:1px solid #dce8e0;border-radius:16px;box-shadow:0 10px 35px #0003;display:flex;flex-direction:column;overflow:hidden;color:#183329;font:14px/1.5 system-ui}\n#hfAiPanel[hidden],#hfAiToggle[hidden]{display:none}\n#hfAiHead{display:flex;align-items:center;justify-content:space-between;background:#176b4d;color:#fff;padding:12px 14px;font-weight:800}\n#hfAiClose{background:transparent;border:0;color:#fff;font-size:22px;cursor:pointer}\n#hfAiMessages{padding:12px;overflow:auto;flex:1;background:#f7faf8}\n.hfAiMsg{white-space:pre-wrap;overflow-wrap:anywhere;background:#fff;border:1px solid #dce8e0;border-radius:12px;padding:9px 11px;margin:7px 0;max-width:90%}\n.hfAiMsg.user{margin-inline-start:auto;background:#eaf5ef}\n#hfAiForm{padding:10px;border-top:1px solid #dce8e0;display:flex;gap:7px}\n#hfAiInput{min-width:0;flex:1;border:1px solid #cbd9d0;border-radius:9px;padding:9px;font:inherit}\n#hfAiSend{border:0;border-radius:9px;padding:8px 12px;background:#176b4d;color:#fff;font-weight:700}\n#hfAiSend:disabled{opacity:.5}';
document.head.appendChild(style);
const toggle=document.createElement('button');toggle.id='hfAiToggle';toggle.type='button';toggle.hidden=true;
const panel=document.createElement('section');panel.id='hfAiPanel';panel.hidden=true;panel.setAttribute('aria-label','HelferFix AI Support');
panel.innerHTML='<div id="hfAiHead"><span id="hfAiTitle"></span><button id="hfAiClose" type="button" aria-label="Close">×</button></div><div id="hfAiMessages" aria-live="polite"></div><form id="hfAiForm"><input id="hfAiInput" maxlength="1200" required><button id="hfAiSend" type="submit"></button></form>';
document.body.append(toggle,panel);
const $=id=>document.getElementById(id);
function addMessage(text,who='assistant'){const node=document.createElement('div');node.className='hfAiMsg '+who;node.textContent=text;$('hfAiMessages').appendChild(node);$('hfAiMessages').scrollTop=$('hfAiMessages').scrollHeight;}
function renderText(){const t=languages[language()];toggle.textContent='✦ '+t.open;$('hfAiTitle').textContent=t.title;$('hfAiInput').placeholder=t.placeholder;$('hfAiSend').textContent=t.send;$('hfAiClose').setAttribute('aria-label',t.close);panel.dir=language()==='ar'?'rtl':'ltr';}
toggle.addEventListener('click',()=>{panel.hidden=false;toggle.hidden=true;renderText();});
$('hfAiClose').addEventListener('click',()=>{panel.hidden=true;toggle.hidden=false;});
$('hfAiForm').addEventListener('submit',async event=>{
 event.preventDefault();if(busy)return;
 const text=$('hfAiInput').value.trim();if(!text)return;
 const t=languages[language()];history.push({role:'user',content:text});history=history.slice(-8);addMessage(text,'user');$('hfAiInput').value='';busy=true;$('hfAiSend').disabled=true;$('hfAiSend').textContent=t.busy;
 try{
  const response=await fetch('/api/support/assistant/message',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({language:language(),messages:history})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||t.failed);
  const answer=String(data.answer||'').slice(0,4000);history.push({role:'assistant',content:answer});history=history.slice(-8);addMessage(answer);
 }catch(error){addMessage(error.message||t.failed);}
 finally{busy=false;$('hfAiSend').disabled=false;$('hfAiSend').textContent=languages[language()].send;}
});
const langSelect=document.querySelector('#language');if(langSelect)langSelect.addEventListener('change',renderText);
fetch('/api/support/assistant/status',{credentials:'same-origin'}).then(r=>r.ok?r.json():null).then(data=>{
 if(!data?.enabled)return;
 renderText();toggle.hidden=false;addMessage(languages[language()].intro);
}).catch(()=>{});
})();