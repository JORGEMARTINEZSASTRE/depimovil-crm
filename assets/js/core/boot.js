/* ══════════════════════════════════
   BOOT
══════════════════════════════════ */


/* ==================================
   DOCUMENTOS OPERADORA (parche)
================================== */
function copyPortalLink(token){
  var safeToken=String(token||'').replace(/[^a-zA-Z0-9_-]/g,'');
  var url=window.location.origin+'/portal.html?token='+safeToken;
  navigator.clipboard.writeText(url).then(function(){showToast('📋 Link del portal copiado');}).catch(function(){prompt('Copiá este link:',url);});
}
var opDocsRefreshTimer=null;
var opDocsRefreshId=null;
var opDocsSignatures={};
function opDocsNormalizeList(docs){
  return (docs||[]).map(function(d){
    return typeof normalizeOperadoraDoc==='function'?normalizeOperadoraDoc(d):d;
  });
}
function opDocsSignature(docs){
  return opDocsNormalizeList(docs).map(function(d){
    return [d.id,d.tipo,d.archivo_url,d.maquina_id,d.firmado_en,d.updated_at,d.created_at].join(':');
  }).sort().join('|');
}
function cacheOperadoraDocs(opId, docs){
  var normalized=opDocsNormalizeList(docs);
  var signature=opDocsSignature(normalized);
  var prev=opDocsSignatures[opId]||'';
  opDocsSignatures[opId]=signature;
  var all=DB.get('documentos_operadora')||[];
  var others=all.filter(function(d){return parseInt(d.operadora_id)!==parseInt(opId);});
  DB.set('documentos_operadora',others.concat(normalized));
  return signature!==prev;
}
function activeViewId(){
  var active=document.querySelector('.view.active');
  return active?String(active.id||'').replace(/^view-/,''):'';
}
function refreshOperadoraLivePanels(opId, changed){
  if(!changed)return;
  var panel=document.getElementById('op360Panel_'+opId);
  if(panel&&typeof renderOp360Panel==='function'){
    var op=(DB.get('operadoras')||[]).find(function(o){return parseInt(o.id)===parseInt(opId);});
    if(op)panel.outerHTML=renderOp360Panel(op);
  }
  if(typeof refreshRevisionOperadoraOpen==='function')refreshRevisionOperadoraOpen(opId);
  if(typeof updateRevisionOperadorasBadge==='function')updateRevisionOperadorasBadge();
}
function startOpDocsAutoRefresh(opId){
  if(!opId)return;
  opDocsRefreshId=opId;
  if(opDocsRefreshTimer)clearInterval(opDocsRefreshTimer);
  opDocsRefreshTimer=setInterval(function(){
    var body=document.getElementById('docsBody_'+opDocsRefreshId);
    var revModal=document.getElementById('modalRevisionOperadora');
    var revisionOpen=revModal&&revModal.classList.contains('open');
    if(activeViewId()!=='operadora-ficha'&&!body&&!revisionOpen){
      clearInterval(opDocsRefreshTimer);
      opDocsRefreshTimer=null;
      opDocsRefreshId=null;
      return;
    }
    loadOpDocs(opDocsRefreshId,true);
  },4000);
}
async function loadOpDocs(opId){
  var body=document.getElementById('docsBody_'+opId);
  try{
    var docs=opDocsNormalizeList(await api('/api/portal/docs/'+opId));
    var changed=cacheOperadoraDocs(opId,docs);
    var cedula=(docs||[]).find(function(d){return d.tipo==='cedula';});
    var cedulaDorso=(docs||[]).find(function(d){return d.tipo==='cedula_dorso';});
    var contratos=(docs||[]).filter(function(d){return d.tipo==='contrato';});
    refreshOperadoraLivePanels(opId,changed);
    if(!body)return;
    var reservas=(DB.get('reservas')||[]).filter(function(r){return r.operadoraId===opId&&['confirmada','activa','aprobada','solicitud_recibida','pendiente_aprobacion'].includes(r.estado);});
    var fileUrl=function(doc){
      if(!doc||!doc.archivo_url)return '';
      return /^https?:\/\//.test(doc.archivo_url)?doc.archivo_url:window.location.origin+doc.archivo_url;
    };
    var fileButton=function(doc,label){
      var url=fileUrl(doc);
      return url?'<a class="action-btn" href="'+escapeAttr(url)+'" target="_blank" rel="noopener">'+escapeHTML(label)+'</a>':'<span class="badge badge-red">'+escapeHTML(label)+' pendiente</span>';
    };
    var h='<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">';
    h+='<div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:14px">';
    h+='<div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">🪪 Cédula</div>';
    h+='<div style="display:flex;gap:6px;flex-wrap:wrap">';
    h+=cedula?'<span class="badge badge-green">✓ Frente</span>':'<span class="badge badge-red">✗ Frente</span>';
    h+=cedulaDorso?'<span class="badge badge-green">✓ Dorso</span>':'<span class="badge badge-red">✗ Dorso</span>';
    h+='</div>';
    h+='<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">'+fileButton(cedula,'Ver frente')+fileButton(cedulaDorso,'Ver dorso')+'</div>';
    if(cedula||cedulaDorso){
      h+='<div style="font-size:11px;color:var(--text3);margin-top:6px">';
      if(cedula)h+='Frente subida '+new Date(cedula.created_at).toLocaleDateString('es-UY');
      if(cedula&&cedulaDorso)h+=' · ';
      if(cedulaDorso)h+='Dorso subido '+new Date(cedulaDorso.created_at).toLocaleDateString('es-UY');
      h+='</div>';
    }
    h+='</div>';
    h+='<div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:14px">';
    h+='<div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">📋 Contratos</div>';
    var contratoFirmado=contratos.find(function(ct){return ct.firmado_en||ct.archivo_url;});
    h+=contratoFirmado?'<span class="badge badge-green">✓ Contrato marco firmado</span>':'<span class="badge badge-yellow">Contrato marco pendiente</span>';
    h+='</div></div>';
    if(contratoFirmado&&contratoFirmado.firmado_en){h+='<div style="font-size:12px;color:var(--text3);margin-top:10px">Firmado '+new Date(contratoFirmado.firmado_en).toLocaleDateString('es-UY')+'. Aplica a todas las reservas y futuros alquileres.</div>';}
    body.innerHTML=h;
  }catch(e){if(body)body.innerHTML='<div style="font-size:12px;color:var(--text3)">No se pudieron cargar documentos.</div>';}
}

/* ==================================
   WHATSAPP PENDIENTES (parche)
================================== */
async function borrarColaServidorWA(id){
  if(!confirm('¿Borrar este WhatsApp pendiente del servidor? No se enviará.'))return;
  try{
    await api('/api/webhook/whatsapp/queue/'+id,{method:'DELETE'});
    DB.set('wa_queue_server',(DB.get('wa_queue_server')||[]).filter(function(q){return parseInt(q.id)!==parseInt(id);}));
    if(typeof cargarColaServidorWA==='function')await cargarColaServidorWA();
    if(typeof updateWABadge==='function')updateWABadge();
    showToast('🗑 WhatsApp pendiente borrado');
    if(typeof renderWA==='function')renderWA('pendientes');
  }catch(e){
    showToast('❌ '+e.message,'error');
  }
}
async function borrarPendientesWA(){
  var notifs=DB.get('wa_notificaciones')||[];
  var locales=notifs.filter(function(n){return n.estado==='pendiente';});
  var serverPend=DB.get('wa_queue_server')||[];
  var total=locales.length+serverPend.length;
  if(!total)return;
  if(!confirm('¿Borrar '+total+' WhatsApp pendiente'+(total!==1?'s':'')+'? No se enviarán.'))return;
  DB.set('wa_notificaciones',notifs.filter(function(n){return n.estado!=='pendiente';}));
  var borradosServidor=0;
  if(serverPend.length){
    try{
      var result=await api('/api/webhook/whatsapp/queue',{method:'DELETE'});
      borradosServidor=result.count||serverPend.length;
      if(typeof cargarColaServidorWA==='function')await cargarColaServidorWA();
    }catch(e){
      DB.set('wa_queue_server_error',e.message);
      showToast('⚠️ Se borraron los locales, pero no la cola del servidor: '+e.message,'warn');
    }
  }
  if(typeof updateWABadge==='function')updateWABadge();
  showToast('🗑 Pendientes borrados: '+(locales.length+borradosServidor));
  if(typeof renderWA==='function')renderWA('pendientes');
}
(function mejorarAccionesWhatsappPendientes(){
  if(typeof renderWA!=='function')return;
  var renderWAOriginal=renderWA;
  renderWA=function(tab){
    var result=renderWAOriginal.apply(this,arguments);
    setTimeout(inyectarAccionesPendientesWA,0);
    return result;
  };
  function inyectarAccionesPendientesWA(){
    if(typeof waActiveTab!=='undefined'&&waActiveTab!=='pendientes')return;
    var el=document.getElementById('waTabContent');
    if(!el)return;
    var locales=(DB.get('wa_notificaciones')||[]).filter(function(n){return n.estado==='pendiente';}).length;
    var server=(DB.get('wa_queue_server')||[]).length;
    var total=locales+server;
    var bulk=document.getElementById('waPendingBulkActions');
    if(!total){if(bulk)bulk.remove();return;}
    if(!bulk){
      bulk=document.createElement('div');
      bulk.id='waPendingBulkActions';
      bulk.style.cssText='display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-bottom:12px';
      el.insertBefore(bulk,el.firstChild);
    }
    bulk.innerHTML='<button class="action-btn danger" onclick="borrarPendientesWA()">🗑 Borrar pendientes ('+total+')</button>';
    el.querySelectorAll('button[onclick^="enviarColaServidorWA("]').forEach(function(btn){
      var match=String(btn.getAttribute('onclick')||'').match(/enviarColaServidorWA\((\d+)\)/);
      if(!match||!btn.parentElement)return;
      var id=match[1];
      if(btn.parentElement.querySelector('[data-wa-delete-server="'+id+'"]'))return;
      btn.insertAdjacentHTML('afterend','<button class="action-btn danger" data-wa-delete-server="'+id+'" onclick="borrarColaServidorWA('+id+')">Borrar pendiente</button>');
    });
  }
})();

initData();
(async()=>{
  await tryRestoreSession();
  if(!currentUser && typeof configureLoginEntry==='function') configureLoginEntry();
  if(!currentUser && typeof openOperadoraRegistroFromLink==='function') openOperadoraRegistroFromLink();
})();
