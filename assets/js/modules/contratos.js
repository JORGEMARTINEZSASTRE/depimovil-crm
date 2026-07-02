/* ══════════════════════════════════
   CONTRATOS
══════════════════════════════════ */
let contratoFilter = {search:'', estado:''};

function getContratos(){
  return JSON.parse(localStorage.getItem('dm_contratos') || '[]');
}

function setContratos(contratos){
  localStorage.setItem('dm_contratos', JSON.stringify(contratos));
  _contratos = contratos;
  _ctrNextId = contratos.length ? Math.max(...contratos.map(c=>c.id||0)) + 1 : 1;
}

function badgeContrato(estado){
  const map = {
    activo: ['badge-green','Activo'],
    finalizado: ['badge-blue','Finalizado'],
    anulado: ['badge-red','Anulado'],
  };
  const cfg = map[estado] || ['badge-gray', estado || 'Sin estado'];
  return `<span class="badge ${cfg[0]}">${cfg[1]}</span>`;
}

function badgeFirmaContrato(c){
  if(c.firmado) return `<span class="badge badge-green">Firmado</span>${c.fechaFirma ? `<div style="font-size:11px;color:var(--text3);margin-top:3px">${fmtDate(c.fechaFirma)}</div>` : ''}`;
  return '<span class="badge badge-yellow">Pendiente firma</span>';
}

function renderContratos(){
  const tbody = document.getElementById('contratosTableBody');
  if(!tbody) return;
  const q = (contratoFilter.search || '').toLowerCase();
  const contratos = getContratos().filter(c=>{
    const op = getOp(c.operadoraId);
    const maq = getMaq(c.maquinaId);
    const hay = [
      c.id, c.nombre, c.ci, c.ciudad, c.maquina, c.serial,
      op && `${op.nombre} ${op.apellido || ''}`,
      maq && `${maq.codigo} ${maq.nombre}`
    ].filter(Boolean).join(' ').toLowerCase();
    return (!q || hay.includes(q)) && (!contratoFilter.estado || c.estado === contratoFilter.estado);
  }).sort((a,b)=>(b.id||0)-(a.id||0));

  updateContratosBadge();
  if(!contratos.length){
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><div class="icon">📋</div><h3>Sin contratos</h3><p>No hay contratos para mostrar. <button class="btn-add" onclick="openContratoModal()" style="margin-left:8px">+ Nuevo Contrato</button></p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = contratos.map(c=>{
    const op = getOp(c.operadoraId);
    const maq = getMaq(c.maquinaId);
    const nombre = c.nombre || (op ? `${op.nombre} ${op.apellido || ''}` : '—');
    const maquina = c.maquina || (maq ? `${maq.codigo} — ${maq.nombre}` : '—');
    const monto = formatMonto(c.monto || 0, c.moneda || 'UYU');
    const garantia = c.garantia ? formatMonto(c.garantia, c.moneda || 'UYU') : '—';
    return `<tr>
      <td><span style="font-family:monospace;color:var(--accent);font-size:11px">CTR-${String(c.id||0).padStart(3,'0')}</span></td>
      <td><span class="bold">${nombre}</span><div style="font-size:11px;color:var(--text3)">${c.ci || 'Sin CI/RUT'}</div></td>
      <td>${maquina}</td>
      <td>${fmtDate(c.fechaInicio)} → ${fmtDate(c.fechaFin)}</td>
      <td>${monto}</td>
      <td>${garantia}</td>
      <td>${badgeContrato(c.estado || 'activo')}<div style="margin-top:6px">${badgeFirmaContrato(c)}</div></td>
      <td>
        <button class="action-btn" onclick="previewContrato(${c.id})">👁 Ver/PDF</button>
        <button class="action-btn danger" onclick="deleteContrato(${c.id})">🗑</button>
      </td>
    </tr>`;
  }).join('');
}

function filterContratos(q){
  contratoFilter.search = q || '';
  renderContratos();
}

function filterContratoEstado(estado){
  contratoFilter.estado = estado || '';
  renderContratos();
}

function previewContrato(id){
  const c = getContratos().find(x=>x.id === parseInt(id));
  if(!c) return;
  openContratoModal(c.operadoraId);
  document.getElementById('ctrNombre').value = c.nombre || '';
  document.getElementById('ctrCI').value = c.ci || '';
  document.getElementById('ctrDomicilio').value = c.domicilio || '';
  document.getElementById('ctrCiudad').value = c.ciudad || '';
  document.getElementById('ctrMaquina').value = c.maquinaId || '';
  document.getElementById('ctrSerial').value = c.serial || '';
  document.getElementById('ctrFechaInicio').value = c.fechaInicio || '';
  document.getElementById('ctrFechaFin').value = c.fechaFin || '';
  document.getElementById('ctrMonto').value = c.monto || '';
  document.getElementById('ctrMoneda').value = c.moneda || 'UYU';
  document.getElementById('ctrFormaPago').value = c.formaPago || 'Transferencia bancaria';
  document.getElementById('ctrGarantia').value = c.garantia || '';
  document.getElementById('ctrFirmado').value = c.firmado ? 'firmado' : 'pendiente';
  document.getElementById('ctrFechaFirma').value = c.fechaFirma || '';
  if(typeof _ctrDocumentos !== 'undefined'){
    _ctrDocumentos = { frente: c.cedulaFrente || null, dorso: c.cedulaDorso || null };
    if(typeof updateContratoDocumentoInfo === 'function'){
      updateContratoDocumentoInfo('frente');
      updateContratoDocumentoInfo('dorso');
    }
  }
  document.getElementById('ctrObs').value = c.obs || '';
  calcDuracion();
  switchContratoTab('preview');
}

async function deleteContrato(id){
  if(!confirm('¿Eliminar este contrato del listado?')) return;
  try{
    await api('/api/contratos/'+parseInt(id), {method:'DELETE'});
  }catch(e){
    showToast('⚠️ No se pudo eliminar en servidor. Se quita de esta vista.');
  }
  const contratos = getContratos().filter(c=>c.id !== parseInt(id));
  setContratos(contratos);
  renderContratos();
  showToast('🗑 Contrato eliminado');
}

function updateContratosBadge(){
  const badge = document.getElementById('navBadgeContratos');
  if(!badge) return;
  const count = getContratos().filter(c=>(c.estado || 'activo') === 'activo').length;
  badge.textContent = count;
  badge.style.display = count ? 'inline-flex' : 'none';
}

/* WhatsApp: acciones de borrado para cola pendiente del servidor.
   Este modulo carga al final del CRM, despues de whatsapp.js. */
async function borrarColaServidorWA(id){
  if(!confirm('¿Borrar este WhatsApp pendiente del servidor? No se enviará.')) return;
  try{
    await api('/api/webhook/whatsapp/queue/'+id, {method:'DELETE'});
    DB.set('wa_queue_server', (DB.get('wa_queue_server')||[]).filter(q=>parseInt(q.id)!==parseInt(id)));
    if(typeof cargarColaServidorWA === 'function') await cargarColaServidorWA();
    if(typeof updateWABadge === 'function') updateWABadge();
    showToast('🗑 WhatsApp pendiente borrado');
    if(typeof renderWA === 'function') renderWA('pendientes');
  }catch(e){
    showToast('❌ '+e.message, 'error');
  }
}

async function borrarPendientesWA(){
  const notifs = DB.get('wa_notificaciones')||[];
  const locales = notifs.filter(n=>n.estado==='pendiente');
  const serverPend = DB.get('wa_queue_server')||[];
  const total = locales.length + serverPend.length;
  if(!total) return;
  if(!confirm(`¿Borrar ${total} WhatsApp pendiente${total!==1?'s':''}? No se enviarán.`)) return;

  DB.set('wa_notificaciones', notifs.filter(n=>n.estado!=='pendiente'));
  let borradosServidor = 0;
  if(serverPend.length){
    try{
      const result = await api('/api/webhook/whatsapp/queue', {method:'DELETE'});
      borradosServidor = result.count || serverPend.length;
      if(typeof cargarColaServidorWA === 'function') await cargarColaServidorWA();
    }catch(e){
      DB.set('wa_queue_server_error', e.message);
      showToast('⚠️ Se borraron los locales, pero no la cola del servidor: '+e.message, 'warn');
    }
  }
  if(typeof updateWABadge === 'function') updateWABadge();
  showToast(`🗑 Pendientes borrados: ${locales.length + borradosServidor}`);
  if(typeof renderWA === 'function') renderWA('pendientes');
}

(function instalarBotonesBorradoWhatsApp(){
  if(typeof renderWA !== 'function') return;
  const renderOriginalWA = renderWA;
  renderWA = function(tab){
    const result = renderOriginalWA.apply(this, arguments);
    setTimeout(insertarBotonesBorradoWhatsApp, 0);
    return result;
  };

  function insertarBotonesBorradoWhatsApp(){
    if(typeof waActiveTab !== 'undefined' && waActiveTab !== 'pendientes') return;
    const el = document.getElementById('waTabContent');
    if(!el) return;
    const locales = (DB.get('wa_notificaciones')||[]).filter(n=>n.estado==='pendiente').length;
    const server = (DB.get('wa_queue_server')||[]).length;
    const total = locales + server;
    let bar = document.getElementById('waPendingDeleteBar');
    if(!total){ if(bar) bar.remove(); return; }
    if(!bar){
      bar = document.createElement('div');
      bar.id = 'waPendingDeleteBar';
      bar.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-bottom:12px';
      el.insertBefore(bar, el.firstChild);
    }
    bar.innerHTML = `<button class="action-btn danger" onclick="borrarPendientesWA()">🗑 Borrar pendientes (${total})</button>`;

    el.querySelectorAll('button[onclick^="enviarColaServidorWA("]').forEach(btn=>{
      const match = String(btn.getAttribute('onclick')||'').match(/enviarColaServidorWA\((\d+)\)/);
      if(!match || !btn.parentElement) return;
      const id = match[1];
      if(btn.parentElement.querySelector(`[data-wa-delete-server="${id}"]`)) return;
      btn.insertAdjacentHTML('afterend', `<button class="action-btn danger" data-wa-delete-server="${id}" onclick="borrarColaServidorWA(${id})">Borrar pendiente</button>`);
    });
  }
})();

updateContratosBadge();
