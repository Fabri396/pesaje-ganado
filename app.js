
'use strict';

const $ = id => document.getElementById(id);
const dbName = 'ganado-offline-v1';

let db;
let animals = {};
let records = [];

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function start() {
  db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);

    req.onupgradeneeded = () => {
      const database = req.result;
      database.createObjectStore('settings');
      database.createObjectStore('records', { keyPath: 'id' });
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  $('date').value = new Date().toLocaleDateString('en-CA');
  $('url').value = await get('url') || '';
  $('key').value = await get('key') || '';
  animals = await get('animals') || {};

  await refresh();

  navigator.serviceWorker?.register('./sw.js').catch(() => {});
  updateOnline();
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
  return String(value ?? '')
    .trim()
    .replace(/\.0$/, '')
    .toUpperCase();
}

// Busca un animal usando el arete interno o el ID MAG.
function resolveAnimal(tag) {
  tag = norm(tag);

  if (!tag) {
    return { animal: null, ambiguous: false };
  }

  const matches = new Map();

  for (const [key, value] of Object.entries(animals)) {
    const internal = norm(value.interno);
    const mag = norm(value.mag);

    // Inventario nuevo: una ficha por animal.
    if (value.id && (internal === tag || mag === tag)) {
      matches.set(value.id, value);
    }

    // Compatibilidad con el inventario anterior.
    if (!value.id && norm(key) === tag) {
      matches.set(key, { ...value, id: key });
    }
  }

  if (matches.size > 1) {
    return { animal: null, ambiguous: true };
  }

  return {
    animal: [...matches.values()][0] || null,
    ambiguous: false
  };
}

// Determina si un registro corresponde al mismo animal.
function recordBelongsTo(record, animal, enteredTag) {
  if (animal) {
    if (record.animalId) {
      return record.animalId === animal.id;
    }

    // Compatibilidad con registros anteriores.
    const oldTag = norm(record.arete);

    return oldTag === norm(animal.interno) ||
           oldTag === norm(animal.mag) ||
           oldTag === norm(animal.id);
  }

  return !record.animalId &&
         norm(record.arete) === norm(enteredTag);
}

function lastFor(tag, date) {
  const result = resolveAnimal(tag);

  if (result.ambiguous) return null;

  const animal = result.animal;

  const history = (animal?.history || []).map(item => ({
    fecha: item.fecha,
    peso: item.peso
  }));

  for (const record of records) {
    if (
      recordBelongsTo(record, animal, norm(tag)) &&
      record.fecha < date
    ) {
      history.push({
        fecha: record.fecha,
        peso: record.peso
      });
    }
  }

  return history
    .filter(item => item.fecha < date)
    .sort((a, b) => b.fecha.localeCompare(a.fecha))[0] || null;
}

function daysBetween(first, second) {
  return Math.round(
    (
      Date.parse(second + 'T12:00:00') -
      Date.parse(first + 'T12:00:00')
    ) / 86400000
  );
}

async function refresh() {
  records = await request(store('records').getAll());

  $('pending').textContent =
    records.filter(record => !record.synced).length;

  $('known').textContent = Object.keys(animals).length;

  const rows = records.filter(
    record => record.fecha === $('date').value
  );

  const known = rows.filter(
    record => record.gain !== null &&
              record.gain !== undefined
  );

  const gain = known.reduce(
    (total, record) => total + record.gain, 0
  );

  const validDays = known.filter(record => record.days > 0);

  const average = validDays.length
    ? (
        validDays.reduce(
          (total, record) =>
            total + record.gain * 1000 / record.days,
          0
        ) / validDays.length
      ).toFixed(0)
    : '—';

  $('summary').innerHTML = `
    <div class="stat">
      <span>Registrados</span>
      <b>${rows.length}</b>
    </div>
    <div class="stat">
      <span>Con ganancia calculable</span>
      <b>${known.length}</b>
    </div>
    <div class="stat">
      <span>Kilos ganados</span>
      <b>${gain.toFixed(1)} kg</b>
    </div>
    <div class="stat">
      <span>Promedio gramos/día</span>
      <b>${average}</b>
    </div>
  `;

  showAnimal();
}

function showAnimal() {
  const tag = norm($('tag').value);
  const result = resolveAnimal(tag);
  const animal = result.animal;

  if (!tag) {
    $('animal').textContent =
      'Escribe el arete interno o ID MAG.';
    return;
  }

  if (result.ambiguous) {
    $('animal').textContent =
      '⚠️ Identificación ambigua: coincide con varios animales.';
    return;
  }

  if (!animal) {
    $('animal').textContent =
      '⚠️ Arete desconocido: se registrará para revisión.';
    return;
  }

  if (animal.duplicate) {
    $('animal').textContent =
      '⚠️ Identificación duplicada en inventario.';
    return;
  }

  const previous = lastFor(tag, $('date').value);

  $('animal').textContent =
    `Interno: ${animal.interno || '—'} · ` +
    `MAG: ${animal.mag || '—'} · ` +
    `Lote: ${animal.lote || 'sin lote'} · ` +
    `Último peso: ${
      previous
        ? previous.peso + ' kg (' + previous.fecha + ')'
        : 'sin pesaje previo'
    }`;
}

async function save() {
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
  const animal = result.animal;

  if (result.ambiguous || animal?.duplicate) {
    alert('Identificación duplicada o ambigua. Revisa el inventario.');
    return;
  }

  const alreadyExists = records.some(record =>
    record.fecha === fecha &&
    recordBelongsTo(record, animal, arete)
  );

  if (alreadyExists) {
    alert('Este animal ya fue pesado en esta fecha.');
    return;
  }

  const previous = lastFor(arete, fecha);
  const days = previous
    ? daysBetween(previous.fecha, fecha)
    : null;

  if (days !== null && days <= 0) {
    alert('La fecha debe ser posterior al último pesaje.');
    return;
  }

  const row = {
    id: crypto.randomUUID(),
    animalId: animal?.id || null,
    arete,
    peso,
    fecha,
    gain: previous ? peso - previous.peso : null,
    days,
    lote: animal?.lote || '',
    synced: false
  };

  await request(store('records', 'readwrite').add(row));

  $('tag').value = '';
  $('weight').value = '';

  await refresh();
  $('tag').focus();
}

function updateOnline() {
  $('online').textContent =
    navigator.onLine ? 'Con Internet' : 'Sin Internet';
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

      error ? reject(error) : resolve(data);
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
  try {
    const { url, key } = config();

    $('message').textContent = 'Descargando inventario...';

    const result = await jsonp(url, {
      action: 'inventory',
      key
    });

    if (!result.ok) throw Error(result.error);

    if (!result.animals || typeof result.animals !== 'object') {
      throw Error('El servidor no devolvió un inventario válido.');
    }

    // Conserva los pesajes locales. Solo reemplaza el inventario.
    animals = result.animals;

    await set('animals', animals);
    await set('url', url);
    await set('key', key);
    await refresh();

    $('message').textContent =
      'Inventario descargado. Ya puedes pesar sin Internet.';
  } catch (error) {
    $('message').textContent = 'Error: ' + error.message;
  }
}

async function sync() {
  try {
    const { url, key } = config();

    if (!navigator.onLine) {
      throw Error('No hay conexión');
    }

    await set('url', url);
    await set('key', key);

    const pending = records.filter(record => !record.synced);

    if (!pending.length) {
      $('message').textContent = 'No hay registros pendientes.';
      return;
    }

    for (let i = 0; i < pending.length; i += 20) {
      const batch = pending.slice(i, i + 20);

      $('message').textContent =
        `Enviando ${Math.min(i + 20, pending.length)}/${pending.length}...`;

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
          ids: batch.map(record => record.id).join(',')
        });

        if (!result.ok) throw Error(result.error);

        verified = result.ids;

        if (verified.length === batch.length) break;

        await new Promise(resolve => setTimeout(resolve, 1200));
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
    $('message').textContent =
      'Error: ' + error.message +
      '\nLos registros locales se conservan.';
  }
}

function csv() {
  const rows = [
    [
      'ID', 'Fecha', 'Arete', 'ID animal',
      'Peso kg', 'Ganancia kg', 'Días',
      'Lote', 'Sincronizado'
    ],
    ...records.map(record => [
      record.id,
      record.fecha,
      record.arete,
      record.animalId || '',
      record.peso,
      record.gain ?? '',
      record.days ?? '',
      record.lote,
      record.synced ? 'Sí' : 'No'
    ])
  ];

  const data = '\ufeff' + rows
    .map(row =>
      row.map(value =>
        '"' + String(value).replace(/"/g, '""') + '"'
      ).join(';')
    )
    .join('\r\n');

  const link = document.createElement('a');
  const blob = new Blob([data], {
    type: 'text/csv;charset=utf-8'
  });

  link.href = URL.createObjectURL(blob);
  link.download =
    'respaldo_pesajes_' +
    new Date().toISOString().slice(0, 10) +
    '.csv';

  link.click();

  setTimeout(() => URL.revokeObjectURL(link.href), 3000);
}

$('save').onclick = save;
$('download').onclick = download;
$('sync').onclick = sync;
$('backup').onclick = csv;
$('tag').oninput = showAnimal;
$('date').onchange = refresh;

addEventListener('online', updateOnline);
addEventListener('offline', updateOnline);

start().catch(error =>
  alert('No se pudo iniciar almacenamiento local: ' + error.message)
);
