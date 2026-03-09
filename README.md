# 🚆 RenfeNow — Dashboard Ferroviario en Tiempo Real

Dashboard web interactivo que combina posiciones en tiempo real de trenes Renfe con los horarios en directo de ADIF, desplegado en producción con Docker, GitHub Actions y Nginx.

🔗 **Demo en producción:** [renfenow.automaworks.es](https://renfenow.automaworks.es)

---

## 📋 Descripción del proyecto

RenfeNow integra dos fuentes de datos ferroviarios independientes para ofrecer una visión completa de la red en tiempo real:

- **Posiciones GTFS-RT de Renfe** → localización GPS de todos los trenes en circulación, actualizadas cada 20 segundos
- **Horarios en tiempo real de ADIF** → teleindicador de salidas por estación, con contadores de cuenta atrás, retrasos y estado de vía, vía protocolo SignalR

El resultado es un panel unificado con mapa interactivo, panel de alertas, buscador de estaciones y teleindicador de horarios con filtros por tipo de tren.

---

## 🛠️ Stack tecnológico

| Capa | Herramienta | Detalle |
|---|---|---|
| Backend | **FastAPI** + Uvicorn | API REST async, endpoints GTFS-RT y catálogo estaciones |
| Frontend | **Leaflet.js** + Vanilla JS | Mapa interactivo, marcadores en tiempo real |
| Horarios ADIF | **SignalR** (WebSocket) | Conexión directa desde el navegador a `wss://info.adif.es` |
| Datos estaciones | CSV propio + JSON catálogo | 1.680 estaciones con coordenadas + 1.071 apeaderos Cercanías |
| Contenerización | **Docker** | Imagen publicada en GitHub Container Registry |
| CI/CD | **GitHub Actions** | Build + push automático en cada commit a `main` |
| Proxy inverso | **Nginx** | SSL/TLS, WebSocket upgrade, timeouts largos |
| Despliegue | **VPS** (Ubuntu) | Puerto 8000 interno, 443 público vía Nginx |

---

## 🏗️ Arquitectura del sistema

```
┌─────────────────────────────────────────────────────────────┐
│                    NAVEGADOR DEL USUARIO                    │
│                                                             │
│  SignalR ──────────────────────────────► wss://info.adif.es │
│  (horarios en tiempo real, pasa Akamai CDN)                 │
│                                                             │
│  fetch('/api/vehiculos') ──────────────► VPS FastAPI        │
│  fetch('/api/alerts')    ──────────────► VPS FastAPI        │
│  fetch('/api/estaciones')──────────────► VPS FastAPI        │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    VPS — FastAPI (Puerto 8000)               │
│                                                             │
│  GET /api/vehiculos  ──► gtfsrt.renfe.com (GTFS-RT JSON)   │
│  GET /api/alerts     ──► gtfsrt.renfe.com (alertas JSON)    │
│  GET /api/estaciones ──► data/estaciones.csv (1.680 est.)   │
│  GET /api/estaciones/nombres ──► CSV + station_catalog.json │
└─────────────────────────────────────────────────────────────┘
```

### Por qué SignalR va directo desde el navegador

ADIF usa Akamai CDN con TLS fingerprinting que bloquea conexiones desde servidores Python con HTTP 403. El navegador del usuario pasa Akamai sin problemas. Esta decisión de arquitectura elimina la necesidad de un proxy WebSocket en el servidor y reduce la carga del backend.

---

## 📁 Estructura del repositorio

```
renfenow/
│
├── data/
│   ├── estaciones.csv           # 1.680 estaciones con coordenadas GPS
│   └── station_catalog.json     # 1.071 apeaderos de Cercanías sin coords
│
├── static/
│   └── images/
│       └── estacion.svg         # Icono de estación para el mapa
│
├── templates/
│   └── index.html               # Frontend completo (Leaflet + SignalR + JS)
│
├── .github/
│   └── workflows/
│       └── docker-publish.yml   # CI/CD: build + push a ghcr.io en cada push
│
├── main.py                      # Backend FastAPI
├── requirements.txt
├── Dockerfile
├── nginx.conf                   # Configuración Nginx para producción
├── deploy.sh                    # Script de despliegue en VPS
└── README.md
```

---

## 🗂️ Fuentes de datos

### Renfe GTFS-RT
- **Posiciones:** `https://gtfsrt.renfe.com/vehicle_positions.json`
- **Alertas:** `https://gtfsrt.renfe.com/alerts.json`
- Protocolo estándar GTFS Realtime (Google Transit Feed Specification)
- Actualización cada ~20 segundos

### ADIF SignalR
- **Endpoint:** `wss://info.adif.es/InfoStation`
- Protocolo: `JoinInfo('ECM-{codigo}')` → `GetLastMessage('ECM-{codigo}')`
- Campos utilizados: `departure_time`, `countdown`, `delay_out`, `platform`, `commercial_id`, `destinations`, `journey_stops_destination`

### Catálogo de estaciones
- **Fuente primaria:** CSV oficial ADIF (1.680 estaciones con lat/lon, nombre, provincia, CP)
- **Fuente complementaria:** `station_catalog.json` (1.071 apeaderos de Cercanías sin coordenadas)
- El endpoint `/api/estaciones/nombres` fusiona ambas fuentes con `@lru_cache` para servir un mapa `{codigo: nombre}` completo de 2.751 entradas

---

## ⚙️ Instalación y ejecución local

### Requisitos previos
- Python 3.11+
- Docker (opcional, para ejecutar como contenedor)

### Ejecución directa

```bash
# Clonar el repositorio
git clone https://github.com/iflorido/renfenow.git
cd renfenow

# Instalar dependencias
pip install -r requirements.txt

# Arrancar el servidor
uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Abrir en el navegador
# http://localhost:8000
```

### Ejecución con Docker

```bash
# Build de la imagen
docker build -t renfenow .

# Arrancar el contenedor
docker run -p 8000:8000 renfenow

# O usar la imagen publicada en ghcr.io
docker run -p 8000:8000 ghcr.io/iflorido/renfenow:latest
```

---

## 🚀 Despliegue en producción

El flujo de CI/CD es completamente automático:

```
git push origin main
        │
        ▼
GitHub Actions (docker-publish.yml)
        │
        ├── Build imagen Docker
        ├── Push a ghcr.io/iflorido/renfenow:latest
        │
        ▼
VPS (deploy.sh)
        │
        ├── docker pull ghcr.io/iflorido/renfenow:latest
        ├── docker stop renfenow && docker rm renfenow
        └── docker run -d -p 8095:8000 --name renfenow ...
                │
                ▼
        Nginx (puerto 443)
                │
                ├── SSL/TLS (Let's Encrypt)
                ├── WebSocket upgrade headers
                └── proxy_pass → http://127.0.0.1:8095
```

### Configuración Nginx clave para WebSockets

```nginx
proxy_http_version  1.1;
proxy_set_header    Upgrade $http_upgrade;
proxy_set_header    Connection "upgrade";
proxy_read_timeout  3600s;   # Conexiones SignalR persistentes
```

---

## 🗺️ Funcionalidades del dashboard

### Mapa en tiempo real
- Posición GPS de todos los trenes Renfe en circulación
- Marcadores diferenciados por línea y tipo
- Iconos de estación para las 1.680 estaciones del catálogo
- Popup con línea, provincia y nombre del tren al hacer clic

### Panel de alertas
- Alertas de servicio Renfe en tiempo real (incidencias, obras, avisos)
- Actualización automática cada 60 segundos
- Se oculta automáticamente si no hay alertas activas

### Buscador de estaciones
- Búsqueda por nombre con autocompletado
- Filtro por provincia
- Centra el mapa y abre el teleindicador al seleccionar

### Teleindicador de horarios (ADIF)
- Salidas en tiempo real para la estación seleccionada
- Columnas: hora de salida, tipo de tren, destino con paradas intermedias, vía, estado
- Cuenta atrás en minutos para los próximos trenes
- Retraso en minutos cuando aplica
- Filtro por tipo de tren: Cercanías / Alta Velocidad / Larga Distancia / Regional / Servicio Interno
- Filtro por destino con autocompletado

### Tipos de tren soportados
| Tipo | Operadores |
|---|---|
| Cercanías | Renfe Cercanías (todas las líneas C-x) |
| Alta Velocidad | AVE, Alvia, Avant, Avlo, Iryo, Ouigo |
| Larga Distancia | Intercity |
| Regional | Media Distancia, Regional Exprés |
| Servicio Interno | Resto de circulaciones |

---

## 🔧 Endpoints API

| Método | Endpoint | Descripción |
|---|---|---|
| `GET` | `/` | Sirve el frontend (index.html) |
| `GET` | `/api/vehiculos` | Posiciones GTFS-RT de todos los trenes |
| `GET` | `/api/alerts` | Alertas de servicio Renfe (HTML renderizado) |
| `GET` | `/api/estaciones` | Lista de estaciones con coordenadas del CSV |
| `GET` | `/api/estaciones/nombres` | Mapa `{codigo: nombre}` de 2.751 estaciones |

---

## 🗺️ Roadmap

- [x] Backend FastAPI con endpoints GTFS-RT
- [x] Mapa Leaflet con posiciones en tiempo real
- [x] Panel de alertas Renfe
- [x] Buscador de estaciones con autocompletado y filtro por provincia
- [x] Integración SignalR con ADIF (horarios en tiempo real)
- [x] Teleindicador de salidas con cuenta atrás y retraso
- [x] Catálogo unificado de 2.751 estaciones y apeaderos
- [x] Filtros por tipo de tren (5 categorías)
- [x] Filtro por destino en el teleindicador
- [x] Dockerización con imagen en GitHub Container Registry
- [x] CI/CD con GitHub Actions (build + push automático)
- [x] Despliegue en VPS con Nginx + SSL/TLS
- [x] Diseño responsive con footer informativo
- [ ] Modo oscuro / claro configurable
- [ ] Histórico de retrasos por estación
- [ ] Notificaciones push para trenes favoritos
- [ ] PWA — instalable en móvil como aplicación

---

## 👤 Autor

**Ignacio Florido**

Desarrollador especializado en ingeniería de datos, automatización y aplicaciones web con integración de APIs en tiempo real.

| | |
|---|---|
| 🌐 Portfolio & CV | [cv.iflorido.es](https://cv.iflorido.es) |
| 🏢 Agencia | [automaworks.es](https://automaworks.es) |
| 🐙 GitHub | [github.com/iflorido](https://github.com/iflorido) |

---

<div align="center">
  <sub>Desarrollado con ❤️ para <a href="https://automaworks.es">AutomaWorks</a></sub>
</div>
