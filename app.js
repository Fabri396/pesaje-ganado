
'use strict';

const $ = id => document.getElementById(id);
const dbName = 'ganado-offline-v1';

let db;
let animals = {};
let records = [];
let busy = false;

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function store(name, mode = 'readonly') {
  return db.transaction(name, mode).objectStore(name);
}

async function get(key) {
  return request(store('settings').get(key));
}

async function set(key, value) {
  return request(store('settings', 'readwrite').put(value, key));
}

function norm(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/\.0$/, '')
    .toUpperCase();
}

function daysBetween(a, b) {
  return Math.round(
    (
      Date.parse(b + 'T12:00:00') -
      Date.parse(a + 'T12:00:00')
    ) / 86400000
  );
}

function resolveAnimal(tag) {
  tag = norm(tag);

  if (!tag) {
    return { animal: null, ambiguous: false };
  }

  const matches = Object.entries(animals)
    .filter(([key, value]) => {
      return norm(value.interno) === tag ||
        norm(value.mag) === tag ||
        (!value.id && norm(key) === tag);
    })
    .map(([key, value]) => ({
      ...value,
      id: value.id || 'INT:' + norm(key),
      interno: value.interno || (!value.id ? key : ''),
      mag: value.mag || ''
    }));

  if (matches.length > 1 || matches.some(a => a.duplicate)) {
    return { animal: null, ambiguous: true };
  }

  return {
    animal: matches[0] || null,
    ambiguous: false
  };
}

function recordBelongsTo(record, animal) {
  if (!animal) return false;

  if (record.animalId) {
    return record.animalId === animal.id;
  }

  const oldTag = norm(record.arete);
  const resolved = resolveAnimal(oldTag);

  return !resolved.ambiguous &&
    resolved.animal?.id === animal.id;
}

function lastFor(animal, date) {
  if (!animal) return null;

  const history = (animal.history || [])
    .map(h => ({
      fecha: h.fecha,
      peso: Number(h.peso)
    }));

  for (const record of records) {
    if (recordBelongsTo(record, animal)) {
      history.push({
        fecha: record.fecha,
        peso: Number(record.peso)
      });
    }
  }

  return history
    .filter(h =>
      h.fecha < date &&
      Number.isFinite(h.peso)
    )
    .sort((a, b) => b.fecha.localeCompare(a.fecha))[0] || null;
}

function showAnimal() {
  const tag = norm($('tag').value);
  const date = $('date').value;
  const result = resolveAnimal(tag);

  if (!tag) {
    $('animal').textContent =
      'Escribe un arete para consultar el último peso.';
    return;
  }

  if (result.ambiguous) {
    $('animal').textContent =
      '⚠️ Identificación repetida o ambigua. Revisa el inventario.';
    return;
  }

  if (!result.animal) {
    $('animal').textContent =
      '⚠️ Arete desconocido. Se registrará para revisión.';
    return;
  }

  const animal = result.animal;
  const prev = lastFor(animal, date);

  $('animal').textContent =
    'Arete interno: ' + (animal.interno || '—') +
    ' · ID MAG: ' + (animal.mag || '—') +
    ' · Lote: ' + (animal.lote || 'sin lote') +
    ' · Último peso: ' +
    (prev ? prev.peso + ' kg (' + prev.fecha + ')' : 'sin pesaje previo');
}

async function refresh() {
  records = await request(store('records').getAll());

  $('pending').textContent =
    records.filter(r => !r.synced).length;

  $('known').textContent =
    Object.keys(animals).length;

  const today = records.filter(
    r => r.fecha === $('date').value
  );

  const known = today.filter(
    r => r.gain !== null &&
         r.gain !== undefined &&
         Number.isFinite(Number(r.gain))
  );

  const gain = known.reduce(
    (sum, r) => sum + Number(r.gain), 0
  );

  const avg = known.filter(r => r.days > 0);

  const averageGrams = avg.length
    ? (
        avg.reduce(
          (sum, r) =>
            sum + Number(r.gain) * 1000 / r.days,
          0
        ) / avg.length
      ).toFixed(0)
    : '—';

  $('summary').innerHTML =
    '<div class="stat"><span>Registrados</span><b>' +
    today.length + '</b></div>' +
    '<div class="stat"><span>Con ganancia calculable</span><b>' +
    known.length + '</b></div>' +
    '<div class="stat"><span>Kilos ganados</span><b>' +
    gain.toFixed(1) + ' kg</b></div>' +
    '<div class="stat"><span>Promedio gramos/día</span><b>' +
    averageGrams + '</b></div>';

  showAnimal();
}

function setBusy(value) {
  busy = value;

  for (const id of [
    'save',
    'download',
    'sync',
    'deletePending'
  ]) {
    $(id).disabled = value;
  }
}

async function save() {
  if (busy) return;

  const arete = norm($('tag').value);
  const peso = Number($('weight').value);
  const fecha = $('date').value;

  if (
    !arete ||
    !fecha ||
    !$('weight').value ||
    !Number.isFinite(peso) ||
    peso <= 0
  ) {
    alert('Ingresa arete, fecha y peso válido.');
    return;
  }

  const result = resolveAnimal(arete);

  if (result.ambiguous) {
    alert('Este arete es ambiguo. Revisa el inventario.');
    return;
  }

  const animal = result.animal;

  const duplicate = records.some(r => {
    if (r.fecha !== fecha) return false;

    if (animal) {
      return recordBelongsTo(r, animal);
    }

    return !r.animalId && norm(r.arete) === arete;
  });

  if (duplicate) {
    alert('Ese animal ya tiene un pesaje registrado en esta fecha.');
    return;
  }

  const prev = lastFor(animal, fecha);
  const days = prev
    ? daysBetween(prev.fecha, fecha)
    : null;

  if (days !== null && days <= 0) {
    alert('La fecha debe ser posterior al último pesaje.');
    return;
  }

  const row = {
    id: crypto.randomUUID(),
    arete,
    animalId: animal ? animal.id : null,
    peso,
    fecha,
    gain: prev ? peso - prev.peso : null,
    days,
    lote: animal?.lote || '',
    synced: false
  };

  setBusy(true);

  try {
    await request(store('records', 'readwrite').add(row));

    $('tag').value = '';
    $('weight').value = '';

    await refresh();
    $('message').textContent = 'Pesaje guardado en este teléfono.';
    $('tag').focus();
  } catch (error) {
    alert('No se pudo guardar el pesaje: ' + error.message);
  } finally {
    setBusy(false);
  }
}

function updateOnline() {
  $('online').textContent = navigator.onLine
    ? 'Con Internet'
    : 'Sin Internet';
}

function config() {
  const url = $('url').value.trim();
  const key = $('key').value.trim();

  if (
    !/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(url) ||
    !key
  ) {
    throw Error('Configura la URL /exec y la clave.');
  }

  return { url, key };
}

function jsonp(url, params) {
  return new Promise((resolve, reject) => {
    const cb = 'cb_' + Math.random().toString(36).slice(2);
    const script = document.createElement('script');

    const timer = setTimeout(
      () => finish(new Error('Tiempo agotado')),
      25000
    );

    function finish(error, data) {
      clearTimeout(timer);
      script.remove();
      delete window[cb];

      if (error) reject(error);
      else resolve(data);
    }

    window[cb] = data => finish(null, data);

    script.onerror = () =>
      finish(new Error('No se pudo contactar al servidor'));

    script.src = url + '?' + new URLSearchParams({
      ...params,
      callback: cb
    });

    document.head.append(script);
  });
}

async function download() {
  if (busy) return;
  setBusy(true);

  try {
    const { url, key } = config();

    $('message').textContent = 'Descargando inventario...';

    const response = await jsonp(url, {
      action: 'inventory',
      key
    });

    if (!response.ok) {
      throw Error(response.error || 'Error desconocido');
    }

    if (!response.animals || typeof response.animals !== 'object') {
      throw Error('El servidor no devolvió un inventario válido.');
    }

    animals = response.animals;

    await set('animals', animals);
    await set('url', url);
    await set('key', key);

    await refresh();

    $('message').textContent =
      'Inventario descargado. Ya puedes pesar sin Internet.';
  } catch (error) {
    $('message').textContent = 'Error: ' + error.message;
  } finally {
    setBusy(false);
  }
}

async function sync() {
  if (busy) return;
  setBusy(true);

  try {
    const { url, key } = config();

    if (!navigator.onLine) {
      throw Error('No hay conexión');
    }

    await set('url', url);
    await set('key', key);

    const pending = records.filter(r => !r.synced);

    if (!pending.length) {
      $('message').textContent = 'No hay registros pendientes.';
      return;
    }

    for (let i = 0; i < pending.length; i += 20) {
      const batch = pending.slice(i, i + 20);

      $('message').textContent =
        'Enviando ' +
        Math.min(i + 20, pending.length) +
        '/' + pending.length + '...';

      const body = new URLSearchParams({
        key,
        batch: JSON.stringify(batch)
      });

      await fetch(url, {
        method: 'POST',
        mode: 'no-cors',
        body
      });

      let verified = [];

      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await jsonp(url, {
          action: 'status',
          key,
          ids: batch.map(r => r.id).join(',')
        });

        if (!result.ok) {
          throw Error(result.error || 'Error al verificar');
        }

        verified = result.ids || [];

        if (verified.length === batch.length) break;

        await new Promise(resolve =>
          setTimeout(resolve, 1200)
        );
      }

      for (const record of batch) {
        if (verified.includes(record.id)) {
          record.synced = true;
          await request(
            store('records', 'readwrite').put(record)
          );
        }
      }

      if (verified.length !== batch.length) {
        throw Error(
          'Algunos registros no fueron confirmados. ' +
          'No se borraron: reintenta sincronizar.'
        );
      }
    }

    await refresh();

    $('message').textContent =
      'Sincronización verificada. Registros guardados en Google Sheets.';
  } catch (error) {
    await refresh();

    $('message').textContent =
      'Error: ' + error.message +
      '\nLos registros locales se conservan.';
  } finally {
    setBusy(false);
  }
}

function csv() {
  const rows = [
    [
      'ID', 'Fecha', 'Arete', 'ID animal', 'Peso kg',
      'Ganancia kg', 'Días', 'Lote', 'Sincronizado'
    ],
    ...records.map(r => [
      r.id,
      r.fecha,
      r.arete,
      r.animalId || '',
      r.peso,
      r.gain ?? '',
      r.days ?? '',
      r.lote || '',
      r.synced ? 'Sí' : 'No'
    ])
  ];

  const data = '\ufeff' + rows.map(row =>
    row.map(value =>
      '"' + String(value).replace(/"/g, '""') + '"'
    ).join(';')
  ).join('\r\n');

  const blob = new Blob([data], {
    type: 'text/csv;charset=utf-8'
  });

  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download =
    'respaldo_pesajes_' +
    new Date().toISOString().slice(0, 10) +
    '.csv';

  link.click();

  setTimeout(() => URL.revokeObjectURL(link.href), 3000);
}

async function deletePending() {
  if (busy) return;

  try {
    const current = await request(
      store('records').getAll()
    );

    const pending = current.filter(r => !r.synced);

    if (!pending.length) {
      alert('No hay pesajes pendientes de sincronización.');
      return;
    }

    const confirmed = confirm(
      '¿Eliminar ' + pending.length + ' pesajes pendientes?\n\n' +
      'Esta acción no se puede deshacer.\n' +
      'Los pesajes sincronizados y el inventario se conservarán.\n\n' +
      'Se recomienda exportar primero un respaldo CSV.'
    );

    if (!confirmed) return;

    setBusy(true);

    const transaction = db.transaction('records', 'readwrite');
    const recordsStore = transaction.objectStore('records');

    const finished = new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(
        transaction.error || Error('Transacción cancelada')
      );
    });

    // Comprobar nuevamente el estado dentro de la transacción.
    const all = await request(recordsStore.getAll());

    for (const record of all) {
      if (!record.synced) {
        recordsStore.delete(record.id);
      }
    }

    await finished;
    await refresh();

    $('message').textContent =
      'Se eliminaron los pesajes pendientes. ' +
      'El inventario y los registros sincronizados se conservaron.';

  } catch (error) {
    $('message').textContent =
      'Error al borrar pendientes: ' + error.message;
  } finally {
    setBusy(false);
  }
}

async function start() {
  db = await new Promise((resolve, reject) => {
    const open = indexedDB.open(dbName, 1);

    open.onupgradeneeded = () => {
      const database = open.result;

      if (!database.objectStoreNames.contains('settings')) {
        database.createObjectStore('settings');
      }

      if (!database.objectStoreNames.contains('records')) {
        database.createObjectStore('records', {
          keyPath: 'id'
        });
      }
    };

    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });

  $('date').value = new Date().toLocaleDateString('en-CA');
  $('url').value = await get('url') || '';
  $('key').value = await get('key') || '';
  animals = await get('animals') || {};

  await refresh();

  navigator.serviceWorker
    ?.register('./sw.js')
    .catch(() => {});

  updateOnline();
}

$('save').onclick = save;
$('download').onclick = download;
$('sync').onclick = sync;
$('backup').onclick = csv;
$('deletePending').onclick = deletePending;

$('tag').oninput = showAnimal;
$('date').onchange = refresh;

addEventListener('online', updateOnline);
addEventListener('offline', updateOnline);

start().catch(error => {
  alert(
    'No se pudo iniciar almacenamiento local: ' +
    error.message
  );
});
