/* RenfeNow Dashboard — lógica principal */

// ============================================================
// Mapa código → nombre, construido en cargarEstaciones() desde /api/estaciones
// y completado con /api/estaciones/nombres para apeaderos sin coordenadas.
window._stationNamesMap = {};

function stationName(cod) {
    if (!cod) return '';
    const c = String(cod).replace(/^0+/, '');
    const c5 = String(cod).padStart(5, '0');
    return window._stationNamesMap[c5]
        || window._stationNamesMap[c]
        || ('Est.' + cod);
}

// ============================================================
// VARIABLES GLOBALES
// ============================================================
var map = L.map('map', {zoomControl: false}).setView([40.4168, -3.7038], 6);
L.control.zoom({position: 'topleft'}).addTo(map);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd', maxZoom: 20
}).addTo(map);

var layerEstaciones      = L.layerGroup().addTo(map);
var marcadores           = {};
window.lineasActivas     = {};
window.todasLasEstaciones = [];
window.marcadoresEstaciones = {};

// Variables para la conexión ADIF (SignalR directo desde el navegador)
let adifConnection    = null;
let trenesAdifActuales = [];
let codigoEstacionActual = null;

// ============================================================
// UI HELPERS
// ============================================================
function togglePanel(id) { document.getElementById(id).classList.toggle('is-open'); }

function toggleBottomSheet() {
    const sheet = document.getElementById('bottom-sheet');
    sheet.classList.toggle('is-expanded');
    const icon = sheet.querySelector('.toggle-icon-sheet');
    icon.style.transform = sheet.classList.contains('is-expanded') ? 'rotate(180deg)' : 'rotate(0deg)';
}

function crearIcono(color) {
    return L.divIcon({
        className: 'custom-pin',
        html: `<div style="background-color:${color};width:14px;height:14px;border-radius:50%;border:2px solid #0f1d2e;box-shadow:0 0 8px ${color};"></div>`,
        iconSize: [14, 14]
    });
}

// ============================================================
// 1. INICIALIZACIÓN
// ============================================================
async function inicializarDashboard(intentos = 0) {
    try {
        const loader     = document.getElementById('loading-overlay');
        const loaderText = loader.querySelector('p');
        loader.style.display = 'flex';

        if (intentos > 0) loaderText.innerText = `Reintentando conexión (Intento ${intentos + 1})...`;

        const [resVehiculos, resAlertas] = await Promise.all([
            fetch('/api/vehiculos'), fetch('/api/alerts')
        ]);

        if (!resVehiculos.ok || !resAlertas.ok) throw new Error("Fallo HTTP");
        const trenes = await resVehiculos.json();

        if (trenes.length === 0 && intentos < 4) {
            setTimeout(() => inicializarDashboard(intentos + 1), 2500);
            return;
        }

        document.getElementById('lista-avisos').innerHTML = await resAlertas.text();
        procesarTrenes(trenes);
        vincularAlertasYTrenes();
        await cargarEstaciones();

        loader.style.opacity = '0';
        setTimeout(() => loader.style.display = 'none', 500);

        setInterval(actualizarTrenesFondo,  20000);
        setInterval(actualizarAlertasFondo, 60000);

    } catch (error) {
        if (intentos < 4) {
            setTimeout(() => inicializarDashboard(intentos + 1), 2500);
        } else {
            document.getElementById('loading-overlay').innerHTML = `
                <i class="fas fa-plug fa-4x mb-3 text-danger"></i>
                <h3 class="text-danger">Servidores de Renfe saturados</h3>
                <button class="btn btn-outline-primary mt-3" onclick="location.reload()">Recargar Página</button>`;
        }
    }
}

// ============================================================
// 2. TRENES GTFS (MAPA)
// ============================================================
function procesarTrenes(trenes) {
    const listaDiv = document.getElementById('lista-vehiculos');
    listaDiv.innerHTML = '';
    window.lineasActivas = {};

    if (trenes.length === 0) {
        listaDiv.innerHTML = '<div class="p-3 text-center text-warning">No hay trenes.</div>';
        return;
    }

    trenes.forEach(tren => {
        if (!window.lineasActivas[tren.linea_unica]) window.lineasActivas[tren.linea_unica] = [];
        window.lineasActivas[tren.linea_unica].push(tren);

        if (marcadores[tren.id]) {
            marcadores[tren.id].setLatLng([tren.lat, tren.lon]);
        } else {
            const marker = L.marker([tren.lat, tren.lon], {icon: crearIcono('#4a90e2')}).addTo(map);
            marker.bindPopup(`<div style="color:#333;"><strong style="color:#4a90e2;">Línea ${tren.linea}</strong> <span class="text-muted-aviso">(${tren.provincia})</span><br><small>${tren.nombre}</small></div>`);
            marcadores[tren.id] = marker;
        }

        const item = document.createElement('div');
        item.className = 'list-group-item p-2 border-0 border-bottom';
        item.style.cursor = 'pointer';
        item.onclick = () => {
            map.setView([tren.lat, tren.lon], 14);
            marcadores[tren.id].openPopup();
            if (window.innerWidth < 768) togglePanel('panel-flota');
        };
        item.innerHTML = `<div class="d-flex align-items-center">
            <span style="color:#4a90e2;font-size:1.2rem;margin-right:12px;"><i class="fas fa-train"></i></span>
            <div class="flex-grow-1">
                <div class="fw-bold" style="color:#e0e0e0;">Línea ${tren.linea} <span class="badge bg-secondary ms-1">${tren.provincia}</span></div>
                <div class="text-secondary" style="font-size:0.8rem;">${tren.nombre}</div>
            </div></div>`;
        listaDiv.appendChild(item);
    });
}

// ============================================================
// 3. ESTACIONES (MAPA + BUSCADOR)
// ============================================================
async function cargarEstaciones() {
    try {
        // Cargar estaciones con coordenadas (CSV propio) y catálogo de nombres
        const [resEst, resNombres] = await Promise.all([
            fetch('/api/estaciones'),
            fetch('/api/estaciones/nombres')
        ]);
        const estaciones = await resEst.json();
        const nombresExtra = await resNombres.json();

        window.todasLasEstaciones = estaciones;

        // Construir mapa código→nombre a partir de las estaciones cargadas
        // Fuente primaria: CSV propio (con coordenadas y nombres correctos)
        estaciones.forEach(est => {
            if (est.codigo) {
                window._stationNamesMap[est.codigo.padStart(5, '0')] = est.nombre;
            }
        });
        // Fuente secundaria: apeaderos de Cercanías sin coordenadas GPS
        Object.assign(window._stationNamesMap, nombresExtra);
        const provinciasSet = new Set();

        estaciones.forEach(est => {
            if (est.provincia) provinciasSet.add(est.provincia);
            const icon = L.divIcon({
                className: 'station-pin',
                html: `<div class="icono-estacion-svg"></div>`,
                iconSize: [32, 32], iconAnchor: [16, 16]
            });
            const marker = L.marker([est.lat, est.lon], {icon, zIndexOffset: -100});
            marker.bindPopup(`<div style="color:#333;min-width:200px;">
                <strong style="color:#162438;"><i class="fas fa-building text-secondary"></i> ${est.nombre}</strong>
                <hr><small class="text-muted">${est.direccion}</small><br>
                <small><strong>${est.poblacion}</strong> (${est.provincia})</small></div>`);
            layerEstaciones.addLayer(marker);
            window.marcadoresEstaciones[est.codigo] = marker;
        });

        const selectProv = document.getElementById('filtro-provincia');
        Array.from(provinciasSet).sort().forEach(p => selectProv.add(new Option(p, p)));

        inicializarBuscadoresAdif();
        document.getElementById('buscador-estaciones').addEventListener('input', filtrarEstaciones);
        document.getElementById('filtro-provincia').addEventListener('change', filtrarEstaciones);

    } catch (error) { console.error("Error cargando estaciones:", error); }
}

function filtrarEstaciones() {
    const txt   = document.getElementById('buscador-estaciones').value.toLowerCase();
    const prov  = document.getElementById('filtro-provincia').value;
    const lista = document.getElementById('lista-estaciones');

    if (!txt && !prov) {
        lista.innerHTML = '<div class="p-3 text-center text-muted"><i class="fas fa-search fs-4 mb-2"></i><br>Busca o selecciona provincia.</div>';
        return;
    }

    const filtradas = window.todasLasEstaciones.filter(e =>
        e.nombre.toLowerCase().includes(txt) && (prov === '' || e.provincia === prov)
    );
    lista.innerHTML = '';

    if (filtradas.length === 0) {
        lista.innerHTML = '<div class="p-3 text-center text-warning">No hay resultados.</div>';
        return;
    }

    filtradas.slice(0, 50).forEach(est => {
        const div = document.createElement('div');
        div.className = 'list-group-item p-2 border-0 border-bottom';
        div.style.cursor = 'pointer';
        div.onclick = () => {
            map.setView([est.lat, est.lon], 16);
            if (window.marcadoresEstaciones[est.codigo]) window.marcadoresEstaciones[est.codigo].openPopup();
            if (window.innerWidth < 768) togglePanel('panel-estaciones');
        };
        div.innerHTML = `<div class="d-flex align-items-center">
            <span style="color:#b0b8c4;margin-right:12px;"><i class="fas fa-building"></i></span>
            <div><div class="fw-bold text-light">${est.nombre}</div>
            <div class="text-secondary" style="font-size:0.75rem;">${est.poblacion}</div></div></div>`;
        lista.appendChild(div);
    });
}

// ============================================================
// 4. CRUCE ALERTAS ↔ TRENES
// ============================================================
function vincularAlertasYTrenes() {
    const alertas = document.querySelectorAll('.alerta-item');
    const lineasConAlerta = {};

    alertas.forEach(alerta => {
        const lineasStr = alerta.getAttribute('data-lineas');
        if (!lineasStr) return;
        const titulo = alerta.querySelector('strong').innerText;
        const desc   = alerta.querySelector('.text-secondary').innerText;
        lineasStr.split(',').forEach(linea => {
            const l = linea.trim();
            if (!lineasConAlerta[l]) lineasConAlerta[l] = [];
            lineasConAlerta[l].push({titulo, desc, elementoDOM: alerta});
        });
    });

    const trenesPorAlertaHTML = new Map();
    Object.keys(window.lineasActivas).forEach(lineaActiva => {
        const alertasLinea = lineasConAlerta[lineaActiva] || [];
        window.lineasActivas[lineaActiva].forEach(tren => {
            const marker = marcadores[tren.id];
            if (!marker) return;

            if (alertasLinea.length > 0) {
                marker.setIcon(crearIcono('#dc3545'));
                let popup = `<div style="color:#333;max-width:260px;"><strong style="color:#dc3545;">Línea ${tren.linea}</strong> <span class="text-muted-aviso">(${tren.provincia})</span><br><small>${tren.nombre}</small><hr style="margin:8px 0;">`;
                const mostrados = new Set();
                alertasLinea.forEach(al => {
                    if (!mostrados.has(al.titulo)) {
                        popup += `<div style="margin-bottom:8px;"><strong style="color:#dc3545;font-size:0.85rem;"><i class="fas fa-exclamation-triangle"></i> ${al.titulo}</strong><br><span style="font-size:0.8rem;">${al.desc}</span></div>`;
                        mostrados.add(al.titulo);
                    }
                    if (!trenesPorAlertaHTML.has(al.elementoDOM)) trenesPorAlertaHTML.set(al.elementoDOM, []);
                    trenesPorAlertaHTML.get(al.elementoDOM).push(tren);
                });
                marker.bindPopup(popup + '</div>');
            } else {
                marker.setIcon(crearIcono('#4a90e2'));
                marker.bindPopup(`<div style="color:#333;"><strong style="color:#4a90e2;">Línea ${tren.linea}</strong> <span class="text-muted-aviso">(${tren.provincia})</span><br><small>${tren.nombre}</small></div>`);
            }
        });
    });

    alertas.forEach(alerta => {
        const icono          = alerta.querySelector('.icono-alerta');
        const trenesAfectados = trenesPorAlertaHTML.get(alerta) || [];
        if (trenesAfectados.length > 0) {
            alerta.style.borderLeftColor = '#dc3545';
            alerta.style.cursor          = 'pointer';
            icono.style.color            = '#dc3545';
            alerta.onclick = () => {
                if (trenesAfectados.length === 1) map.setView([trenesAfectados[0].lat, trenesAfectados[0].lon], 14);
                else map.fitBounds(L.latLngBounds(trenesAfectados.map(t => [t.lat, t.lon])), {padding: [50, 50]});
                marcadores[trenesAfectados[0].id].openPopup();
                if (window.innerWidth < 768) togglePanel('panel-avisos');
            };
        } else {
            alerta.style.borderLeftColor = '#fd7e14';
            alerta.style.cursor          = 'default';
            icono.style.color            = '#fd7e14';
            alerta.onclick               = null;
        }
    });
}

// ============================================================
// 5. ADIF — CONEXIÓN SIGNALR DIRECTA DESDE EL NAVEGADOR
//    El navegador conecta a wss://info.adif.es/InfoStation
//    sin pasar por el servidor Python → Akamai lo permite
// ============================================================

async function conectarAdif(codigo) {
    const statusBox = document.getElementById('adif-status');
    const tbody     = document.getElementById('adif-tbody');
    const inputB    = document.getElementById('adif-destino-input');

    if (!codigo) return;

    codigoEstacionActual = codigo;
    inputB.disabled = false;
    limpiarDestino(false);

    // Cerrar conexión anterior si existe
    if (adifConnection) {
        try { await adifConnection.stop(); } catch(e) {}
        adifConnection = null;
    }

    trenesAdifActuales = [];
    statusBox.innerHTML = '<i class="fas fa-spinner fa-spin text-warning"></i> Conectando...';
    tbody.innerHTML     = '<tr><td colspan="5" class="text-center text-muted py-5"><i class="fas fa-circle-notch fa-spin fs-3 mb-2"></i><br>Sincronizando con los paneles de la estación...</td></tr>';

    try {
        // Construir conexión SignalR directa a ADIF
        adifConnection = new signalR.HubConnectionBuilder()
            .withUrl('https://info.adif.es/InfoStation', {
                skipNegotiation: true,
                transport: signalR.HttpTransportType.WebSockets
            })
            .configureLogging(signalR.LogLevel.Warning)
            .withAutomaticReconnect([0, 2000, 5000, 10000])
            .build();

        // Callback de datos recibidos
        adifConnection.on('ReceiveMessage', (raw) => {
            try {
                const data = JSON.parse(raw);
                if (data && Array.isArray(data.trains)) {
                    statusBox.innerHTML  = '<i class="fas fa-circle text-success me-1"></i> En vivo';
                    statusBox.style.color = '#28a745';
                    trenesAdifActuales   = data.trains;

                    // Inspector: mostrar JSON crudo del primer tren para diagnóstico
                    const inspector = document.getElementById('json-inspector');
                    const jsonRaw   = document.getElementById('json-raw');
                    if (inspector && jsonRaw && data.trains.length > 0) {
                        inspector.style.display = 'block';
                        jsonRaw.textContent = JSON.stringify(data.trains[0], null, 2);
                    }

                    renderizarTeleindicador();
                }
            } catch(e) { console.error('Error parseando datos ADIF:', e); }
        });

        adifConnection.onreconnecting(() => {
            statusBox.innerHTML = '<i class="fas fa-spinner fa-spin text-warning"></i> Reconectando...';
        });
        adifConnection.onreconnected(() => {
            statusBox.innerHTML = '<i class="fas fa-circle text-success me-1"></i> En vivo';
            // Re-suscribirse tras reconexión
            adifConnection.invoke('JoinInfo', `ECM-${codigo}`).catch(console.error);
        });
        adifConnection.onclose(() => {
            statusBox.innerHTML = '<i class="fas fa-unlink text-danger"></i> Desconectado';
        });

        // Iniciar conexión
        await adifConnection.start();
        console.log(`✅ ADIF SignalR conectado para estación ${codigo}`);

        // Suscribirse al canal de la estación
        await adifConnection.invoke('JoinInfo',       `ECM-${codigo}`);
        await adifConnection.invoke('GetLastMessage', `ECM-${codigo}`);

    } catch(e) {
        console.error('Error conectando a ADIF:', e);
        statusBox.innerHTML = '<i class="fas fa-exclamation-triangle text-danger"></i> Error ADIF';
    }
}

// ============================================================
// 6. BUSCADORES ADIF
// ============================================================
function inicializarBuscadoresAdif() {
    const inputA   = document.getElementById('adif-origen-input');
    const resA     = document.getElementById('adif-origen-results');
    const hiddenA  = document.getElementById('adif-origen-code');
    const btnClearA = document.getElementById('btn-clear-origen');
    const inputB   = document.getElementById('adif-destino-input');
    const resB     = document.getElementById('adif-destino-results');
    const btnClearB = document.getElementById('btn-clear-destino');

    // Origen
    inputA.addEventListener('input', function() {
        const val = this.value.toLowerCase();
        resA.innerHTML = '';
        btnClearA.style.display = val ? 'block' : 'none';
        if (!val) { resA.style.display = 'none'; return; }

        const filtradas = window.todasLasEstaciones.filter(e => e.nombre.toLowerCase().includes(val)).slice(0, 20);
        if (filtradas.length === 0) { resA.style.display = 'none'; return; }

        resA.style.display = 'block';
        filtradas.forEach(est => {
            const div = document.createElement('div');
            div.className = 'autocomplete-item';
            div.innerHTML = `<span><i class="fas fa-map-marker-alt text-muted me-2"></i><strong>${est.nombre}</strong></span>
                             <span class="badge bg-secondary" style="font-size:0.65rem;">${est.provincia}</span>`;
            div.onclick = () => {
                inputA.value  = est.nombre;
                hiddenA.value = est.codigo;
                resA.style.display = 'none';
                conectarAdif(est.codigo);
            };
            resA.appendChild(div);
        });
    });

    // Destino
    inputB.addEventListener('input', function() {
        const val = this.value.toLowerCase();
        resB.innerHTML = '';
        btnClearB.style.display = val ? 'block' : 'none';
        if (!val) { resB.style.display = 'none'; renderizarTeleindicador(); return; }

        const filtradas = window.todasLasEstaciones.filter(e => e.nombre.toLowerCase().includes(val)).slice(0, 20);
        if (filtradas.length === 0) { resB.style.display = 'none'; return; }

        resB.style.display = 'block';
        filtradas.forEach(est => {
            const div = document.createElement('div');
            div.className = 'autocomplete-item';
            div.innerHTML = `<span><i class="fas fa-flag-checkered text-muted me-2"></i><strong>${est.nombre}</strong></span>
                             <span class="badge bg-secondary" style="font-size:0.65rem;">${est.provincia}</span>`;
            div.onclick = () => {
                inputB.value = est.nombre;
                resB.style.display = 'none';
                renderizarTeleindicador();
            };
            resB.appendChild(div);
        });
    });

    // Cerrar dropdowns al clicar fuera
    document.addEventListener('click', function(e) {
        if (e.target !== inputA && !resA.contains(e.target)) resA.style.display = 'none';
        if (e.target !== inputB && !resB.contains(e.target)) resB.style.display = 'none';
    });
}

window.limpiarOrigen = function() {
    document.getElementById('adif-origen-input').value  = '';
    document.getElementById('adif-origen-code').value   = '';
    document.getElementById('btn-clear-origen').style.display = 'none';
    document.getElementById('adif-destino-input').disabled = true;
    limpiarDestino(false);
    if (adifConnection) { adifConnection.stop().catch(() => {}); adifConnection = null; }
    codigoEstacionActual = null;
    trenesAdifActuales   = [];
    document.getElementById('adif-status').innerHTML = '<span class="text-muted">Esperando origen...</span>';
    document.getElementById('adif-tbody').innerHTML  = '<tr><td colspan="5" class="text-center text-muted py-5"><i class="fas fa-train fa-3x mb-3 opacity-50"></i><br>Selecciona una Estación de Origen para ver los trenes</td></tr>';
};

window.limpiarDestino = function(debeRenderizar = true) {
    const input = document.getElementById('adif-destino-input');
    const btn   = document.getElementById('btn-clear-destino');
    if (input) input.value = '';
    if (btn)   btn.style.display = 'none';
    if (debeRenderizar) renderizarTeleindicador();
};

// ============================================================
// 7. TABLA DE HORARIOS
// ============================================================

// Formatea ISO 8601 → "HH:MM"
function formatHora(isoStr) {
    if (!isoStr) return '--:--';
    try {
        return new Date(isoStr).toLocaleTimeString('es-ES', {hour: '2-digit', minute: '2-digit'});
    } catch(e) { return isoStr; }
}

// Devuelve badge y nombre de producto a partir de traffic_type y commercial_id
function getProductoBadge(tren) {
    const tipo    = tren.traffic_type || '';
    const product = tren.commercial_id?.[0]?.product || '';
    const company = tren.company || '';

    // Empresa no-Renfe
    if (company === 'IRYO' || ['IRYO','IRY'].includes(product))
        return { badge: 'bg-danger', nombre: 'Iryo' };
    if (company === 'OUIGO' || ['OUIGO','OUI'].includes(product))
        return { badge: 'bg-info text-dark', nombre: 'Ouigo' };

    // Por producto específico
    const map = {
        'AVE': { badge: 'bg-warning text-dark', nombre: 'AVE' },
        'AVE624': { badge: 'bg-warning text-dark', nombre: 'AVE' },
        'ALVIA': { badge: 'bg-warning text-dark', nombre: 'Alvia' },
        'AVANT': { badge: 'bg-warning text-dark', nombre: 'Avant' },
        'AVA':   { badge: 'bg-warning text-dark', nombre: 'Avant' },
        'AVLO':  { badge: 'bg-success', nombre: 'Avlo' },
        'CERCAN':{ badge: 'bg-danger', nombre: 'Cercanías' },
        'MD':    { badge: 'bg-secondary', nombre: 'Media Dist.' },
        'REX':   { badge: 'bg-secondary', nombre: 'Reg. Exprés' },
        'ICITY': { badge: 'bg-primary', nombre: 'Intercity' },
        'INTC':  { badge: 'bg-primary', nombre: 'Intercity' },
    };
    if (map[product]) return map[product];

    // Por tipo de tráfico
    if (tipo === 'C') return { badge: 'bg-danger',              nombre: 'Cercanías' };
    if (tipo === 'A') return { badge: 'bg-warning text-dark',   nombre: 'Alta Vel.' };
    if (tipo === 'R') return { badge: 'bg-secondary',           nombre: 'Regional' };
    if (tipo === 'L') return { badge: 'bg-primary',             nombre: 'Larga Dist.' };
    return { badge: 'bg-secondary', nombre: product || tipo || '?' };
}

// Extrae línea de Cercanías limpia (ej: "C-5") desde commercial_id[0].product
// El product viene como "C05CERMAD" → limpiamos sufijos → "C05" → "C-5"
function getLineaCercanias(tren) {
    if (tren.traffic_type !== 'C') return '';
    const raw = tren.commercial_id?.[0]?.product
             || tren.destinations?.[0]?.line
             || '';
    if (!raw) return '';
    // Quitar sufijos como CERMAD, CERBAR, etc. → quedarnos con "C05", "C10"...
    const limpia = raw.replace(/CER[A-Z]*/g, '').replace(/MAD|BAR|VAL|SEV|BIL|ZAR|AST|MDR/g, '').trim();
    // Formatear C05 → C-5, C10 → C-10
    return limpia.replace(/([A-Z]+)0*([1-9][0-9]?)/g, '$1-$2').toUpperCase();
}

// ── Filtros activos por tipo de tren ─────────────────────────────────────────
const filtrosActivos = new Set(['cercania','altavel','largadist','regional','interno']);

function toggleFiltro(btn) {
    const f = btn.dataset.filtro;
    if (filtrosActivos.has(f)) {
        filtrosActivos.delete(f);
        btn.classList.remove('activo');
    } else {
        filtrosActivos.add(f);
        btn.classList.add('activo');
    }
    renderizarTeleindicador();
}

// Clasifica un tren en uno de los 5 grupos de filtro
function clasificarTren(tren) {
    const tipo    = tren.traffic_type || '';
    const product = tren.commercial_id?.[0]?.product || '';
    const company = tren.company || '';

    if (tipo === 'C' || product.startsWith('C0') || product.includes('CER'))
        return 'cercania';
    if (['IRYO','IRY'].includes(company) || ['IRYO','IRY'].includes(product)
        || ['OUIGO','OUI'].includes(company) || ['OUIGO','OUI'].includes(product)
        || ['AVE','AVE624','ALVIA','AVANT','AVA','AVLO'].includes(product)
        || tipo === 'A')
        return 'altavel';
    if (['ICITY','INTC','LD'].includes(product) || tipo === 'L')
        return 'largadist';
    if (['MD','REX','RG'].includes(product) || tipo === 'R')
        return 'regional';
    return 'interno';
}

function renderizarTeleindicador() {
    const inputB       = document.getElementById('adif-destino-input');
    const destinoSelec = inputB ? inputB.value.toLowerCase() : '';
    const tbody        = document.getElementById('adif-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    let filtrados = trenesAdifActuales || [];

    // Filtrar por destino: buscar en el nombre resuelto del destino
    if (destinoSelec) {
        filtrados = filtrados.filter(t => {
            const destCode = t.destinations?.[0]?.code;
            const destNombre = stationName(destCode).toLowerCase();
            return destNombre.includes(destinoSelec);
        });
    }

    // Filtrar por tipo de tren
    filtrados = filtrados.filter(t => filtrosActivos.has(clasificarTren(t)));

    if (filtrados.length === 0) {
        tbody.innerHTML = trenesAdifActuales.length === 0
            ? `<tr><td colspan="6" class="text-center text-muted py-4">ADIF no reporta trenes en este momento para esta estación.</td></tr>`
            : `<tr><td colspan="6" class="text-center text-muted py-4">Ningún tren coincide con los filtros activos.</td></tr>`;
        return;
    }

    filtrados.forEach(tren => {
        // ── Hora ──────────────────────────────────────────────────────────
        // departure_time = hora de salida desde esta estación (lo que muestra el panel)
        const hora = formatHora(tren.departure_time || tren.arrival_time);

        // ── Destino final ─────────────────────────────────────────────────
        // destinations[0].code contiene el código de la estación final
        const destCode  = tren.destinations?.[0]?.code;
        const destNombre = stationName(destCode) || `Est.${destCode || '?'}`;

        // ── Vía ───────────────────────────────────────────────────────────
        const via = tren.platform || tren.platform_in || '-';

        // ── Línea Cercanías ───────────────────────────────────────────────
        const linea = getLineaCercanias(tren);

        // ── Producto / badge ──────────────────────────────────────────────
        const prod = getProductoBadge(tren);

        // ── Número comercial ──────────────────────────────────────────────
        // commercial_id[0].numbers[0] tiene el número visible en los paneles
        const numTren = tren.commercial_id?.[0]?.numbers?.[0]
                     || tren.technical_number_out
                     || tren.technical_number_planif
                     || '';

        // ── Cuenta atrás / retraso ────────────────────────────────────────
        // countdown = minutos para la salida; delay_out = retraso en segundos
        const countdown  = tren.countdown;       // número o null
        const delaySeg   = tren.delay_out || 0;  // segundos
        const delayMin   = Math.round(delaySeg / 60);

        let estado;
        if (typeof countdown === 'number' && countdown >= 0 && countdown <= 60) {
            // Mostrar cuenta atrás si está disponible y es razonable
            if (countdown === 0) {
                estado = `<span class="text-warning fw-bold" style="font-size:0.85rem;"><i class="fas fa-train"></i> Saliendo</span>`;
            } else {
                estado = `<span style="color:#4a90e2; font-size:0.85rem; font-weight:bold;">${countdown} min</span>`;
            }
            if (delayMin > 0) {
                estado += `<br><span class="text-danger" style="font-size:0.75rem;">+${delayMin}min retraso</span>`;
            }
        } else if (delayMin > 0) {
            estado = `<span class="text-danger fw-bold" style="font-size:0.85rem;"><i class="fas fa-exclamation-circle"></i> +${delayMin}min</span>`;
        } else {
            estado = `<span class="text-success" style="font-size:0.85rem;"><i class="fas fa-check-circle"></i> En hora</span>`;
        }

        // ── Paradas intermedias ───────────────────────────────────────────
        const stopsRaw = tren.journey_stops_destination || [];
        const paradas  = stopsRaw.map(s => stationName(s.code)).filter(Boolean);
        const paradasSinFinal = paradas.slice(0, -1);

        const paradasHtml = paradasSinFinal.length > 0
            ? `<div class="paradas-list">${paradasSinFinal.map(p => `<span class="parada-chip">${p}</span>`).join('')}</div>`
            : '';

        // ── Estación de origen (donde está el usuario) ────────────────────
        const origenNombre = codigoEstacionActual
            ? stationName(codigoEstacionActual)
            : '';
        const origenHtml = origenNombre
            ? `<div class="hora-origen"><i class="fas fa-map-marker-alt me-1" style="font-size:0.65rem;"></i>${origenNombre}</div>`
            : '';

        // ── HTML de la fila ───────────────────────────────────────────────
        const badgeProd  = `<span class="badge ${prod.badge}" style="font-size:0.75rem;">${prod.nombre}</span>`;
        const badgeLinea = linea ? `<span class="badge bg-dark border ms-1" style="font-size:0.72rem; color:#4a90e2; border-color:#233652 !important;">${linea}</span>` : '';
        const numHtml    = numTren ? `<div style="color:#a8c0d6; font-size:0.7rem; margin-top:4px;">Tren nº ${numTren}</div>` : '';

        tbody.innerHTML += `<tr>
            <td style="white-space:nowrap; vertical-align:top;">
                <div class="hora-salida">${hora}</div>
                ${origenHtml}
            </td>
            <td style="vertical-align:top; padding-top:10px;">${badgeProd}${badgeLinea}${numHtml}</td>
            <td style="vertical-align:top; padding-top:10px;">
                <div class="dest-nombre">${destNombre}</div>
                ${paradasHtml}
            </td>
            <td class="text-center" style="vertical-align:top; padding-top:12px;"><span class="via-glow">${via}</span></td>
            <td class="text-end" style="vertical-align:top; padding-top:10px;">${estado}</td>
        </tr>`;
    });
}

// ============================================================
// 8. ACTUALIZACIONES PERIÓDICAS (RENFE GTFS)
// ============================================================
async function actualizarTrenesFondo() {
    try {
        const res = await fetch('/api/vehiculos');
        if (res.ok) { procesarTrenes(await res.json()); vincularAlertasYTrenes(); }
    } catch(e) {}
}
async function actualizarAlertasFondo() {
    try {
        const res = await fetch('/api/alerts');
        if (res.ok) { document.getElementById('lista-avisos').innerHTML = await res.text(); vincularAlertasYTrenes(); }
    } catch(e) {}
}

// ============================================================
// ARRANQUE
// ============================================================
inicializarDashboard();
