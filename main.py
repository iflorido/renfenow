import asyncio
import json
import logging
import httpx
import csv
import os
import re
import websockets
import websockets.exceptions
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ==========================================
# 1. VARIABLES GLOBALES Y ESTADO (ADIF)
# ==========================================
station_data: dict[str, dict] = {}
ws_clients: dict[str, list[WebSocket]] = {}
signalr_connections: dict[str, asyncio.Task] = {}

ADIF_WS_URL   = "wss://info.adif.es/InfoStation"
ADIF_HTTP_URL = "https://info.adif.es/"  # para obtener cookies de Akamai

# ==========================================
# 2. VARIABLES GLOBALES (RENFE GTFS-RT)
# ==========================================
URL_ALERTS   = "https://gtfsrt.renfe.com/alerts.json"
URL_VEHICLES = "https://gtfsrt.renfe.com/vehicle_positions.json"

NUCLEOS_RENFE = {
    "10": "Madrid",      "20": "Asturias",          "30": "Sevilla",
    "31": "Cádiz",       "32": "Málaga",             "40": "Valencia",
    "41": "Murcia/Alicante", "50": "Rodalies Catalunya", "51": "Rodalies Catalunya",
    "60": "Bilbao",      "61": "San Sebastián",      "62": "Santander",
    "70": "Zaragoza",
}

# ==========================================
# 3. CICLO DE VIDA (LIFESPAN)
# ==========================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    for task in signalr_connections.values():
        try:
            task.cancel()
        except Exception:
            pass

app = FastAPI(title="Dashboard Renfe & ADIF", lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ==========================================
# 4. FUNCIONES AUXILIARES (ADIF)
# ==========================================

async def get_akamai_cookies() -> str:
    """
    Visita info.adif.es para que Akamai genere las cookies de sesión
    (ak_bmsc, bm_sz, etc.) necesarias para que el WebSocket no reciba 403.
    Devuelve la cabecera Cookie lista para usar.
    """
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
    }
    try:
        async with httpx.AsyncClient(headers=headers, follow_redirects=True, timeout=15) as client:
            r = await client.get(ADIF_HTTP_URL)
            cookies = dict(r.cookies)
            logger.info(f"Cookies Akamai obtenidas: {list(cookies.keys())}")
            return "; ".join(f"{k}={v}" for k, v in cookies.items())
    except Exception as e:
        logger.warning(f"No se pudieron obtener cookies de Akamai: {e}")
        return ""


async def adif_listener(station_code: str):
    """
    Conecta al hub SignalR de ADIF usando websockets nativo.
    Implementa el protocolo SignalR manualmente (handshake + mensajes JSON + separador \\x1e).
    Se reconecta automáticamente si la conexión cae.
    """
    HANDSHAKE = json.dumps({"protocol": "json", "version": 1}) + "\x1e"
    JOIN_MSG  = json.dumps({"type": 1, "target": "JoinInfo",       "arguments": [f"ECM-{station_code}"]}) + "\x1e"
    LAST_MSG  = json.dumps({"type": 1, "target": "GetLastMessage", "arguments": [f"ECM-{station_code}"]}) + "\x1e"

    logger.info(f"[{station_code}] Iniciando listener WebSocket...")

    while station_code in signalr_connections:
        try:
            # Paso 1: obtener cookies de sesión de Akamai
            cookie_header = await get_akamai_cookies()

            ws_headers = {
                "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                "Origin":          "https://info.adif.es",
                "Referer":         "https://info.adif.es/",
                "Accept-Language": "es-ES,es;q=0.9",
                "Cache-Control":   "no-cache",
                "Pragma":          "no-cache",
                "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits",
            }
            if cookie_header:
                ws_headers["Cookie"] = cookie_header

            # Paso 2: conectar WebSocket
            async with websockets.connect(
                ADIF_WS_URL,
                additional_headers=ws_headers,
                ping_interval=20,
                ping_timeout=30,
                open_timeout=15,
            ) as ws:
                logger.info(f"[{station_code}] Conectado. Enviando handshake SignalR...")

                # Paso 3: handshake SignalR obligatorio
                await ws.send(HANDSHAKE)
                hs_resp = await asyncio.wait_for(ws.recv(), timeout=10)
                logger.info(f"[{station_code}] Handshake respuesta: {hs_resp[:100]}")

                # Paso 4: unirse al canal de la estación
                await ws.send(JOIN_MSG)
                await ws.send(LAST_MSG)
                logger.info(f"[{station_code}] Suscrito a ECM-{station_code} ✓")

                # Paso 5: escuchar mensajes
                async for raw in ws:
                    if station_code not in signalr_connections:
                        break
                    for frame in raw.split("\x1e"):
                        frame = frame.strip()
                        if not frame:
                            continue
                        try:
                            msg = json.loads(frame)
                            # type 6 = keepalive ping, ignorar
                            if msg.get("type") == 6:
                                continue
                            # type 1 + target ReceiveMessage = datos de trenes
                            if msg.get("type") == 1 and msg.get("target") == "ReceiveMessage":
                                data = json.loads(msg["arguments"][0])
                                if "trains" in data:
                                    station_data[station_code] = data
                                    logger.info(f"[{station_code}] {len(data['trains'])} trenes actualizados")
                                    await broadcast(station_code, data)
                        except (json.JSONDecodeError, KeyError, IndexError):
                            pass

        except asyncio.CancelledError:
            logger.info(f"[{station_code}] Listener cancelado correctamente.")
            break
        except Exception as e:
            logger.error(f"[{station_code}] Error: {e}. Reconectando en 5s...")
            if station_code in signalr_connections:
                await asyncio.sleep(5)

    logger.info(f"[{station_code}] Listener finalizado.")


async def subscribe_station(station_code: str):
    """Crea y registra la tarea asyncio de escucha para la estación dada."""
    if station_code in signalr_connections:
        return
    task = asyncio.create_task(adif_listener(station_code))
    signalr_connections[station_code] = task


async def broadcast(station_code: str, data: dict):
    """Reenvía los datos a todos los clientes WebSocket del frontend suscritos a esta estación."""
    clients = ws_clients.get(station_code, [])
    dead = []
    for ws in clients:
        try:
            await ws.send_json(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.remove(ws)

# ==========================================
# 5. FUNCIONES AUXILIARES (RENFE HTTPX)
# ==========================================
async def fetch_data(url: str, retries: int = 3):
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36"}
    async with httpx.AsyncClient(verify=False, headers=headers) as client:
        for attempt in range(retries):
            try:
                response = await client.get(url, timeout=15.0)
                response.raise_for_status()
                data = response.json()
                if "entity" in data and len(data["entity"]) > 0:
                    return data
                elif attempt < retries - 1:
                    await asyncio.sleep(1.5)
                else:
                    return data
            except Exception:
                if attempt < retries - 1:
                    await asyncio.sleep(2)
                else:
                    return {"entity": []}

# ==========================================
# 6. ENDPOINTS FRONTEND
# ==========================================
@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

# ==========================================
# 7. ENDPOINTS API (RENFE)
# ==========================================
@app.get("/api/alerts", response_class=HTMLResponse)
async def get_alerts(request: Request):
    data = await fetch_data(URL_ALERTS)
    avisos = []
    for entity in data.get("entity", []):
        alert = entity.get("alert", {})
        translations = alert.get("descriptionText", {}).get("translation", [])
        informed_entity = alert.get("informedEntity", [])
        lineas_afectadas = set()
        for ie in informed_entity:
            route_id = ie.get("routeId", "")
            match = re.search(r'^(\d{2}).*?([A-Za-z]+[0-9]+[A-Za-z]*)$', route_id)
            if match:
                lineas_afectadas.add(f"{match.group(1)}-{match.group(2)}")
        if translations:
            full_text = translations[0].get("text", "Aviso sin descripción")
            partes = full_text.split(" ", 1)
            if len(partes) > 1 and (partes[0].startswith("#") or partes[0].endswith(":")):
                titulo, descripcion = partes[0], partes[1]
            else:
                titulo, descripcion = "Información de Servicio", full_text
            avisos.append({"titulo": titulo, "descripcion": descripcion, "lineas": ",".join(lineas_afectadas)})
    return templates.TemplateResponse("partials/alerts.html", {"request": request, "avisos": avisos})


@app.get("/api/vehiculos")
async def get_vehiculos():
    data = await fetch_data(URL_VEHICLES)
    trenes = []
    for entity in data.get("entity", []):
        vehicle_info = entity.get("vehicle", {})
        pos      = vehicle_info.get("position", {})
        veh_data = vehicle_info.get("vehicle", {})
        trip     = vehicle_info.get("trip", {})
        lat, lon = pos.get("latitude"), pos.get("longitude")
        if lat and lon:
            label       = veh_data.get("label", "Desconocido")
            linea_corta = label.split("-")[0] if "-" in label else "Genérica"
            trip_id     = trip.get("tripId", "")
            region_code = trip_id[:2] if len(trip_id) >= 2 else "00"
            provincia   = NUCLEOS_RENFE.get(region_code, f"Región {region_code}")
            trenes.append({
                "id": entity.get("id"), "linea_unica": f"{region_code}-{linea_corta}",
                "linea": linea_corta, "nombre": label,
                "lat": lat, "lon": lon, "provincia": provincia
            })
    return JSONResponse(content=trenes)


@app.get("/api/estaciones")
async def get_estaciones():
    estaciones = []
    file_path = os.path.join("data", "estaciones.csv")
    if os.path.exists(file_path):
        with open(file_path, mode="r", encoding="latin-1") as f:
            reader = csv.DictReader(f, delimiter=";")
            for row in reader:
                try:
                    lat = float(row.get("LATITUD", "0").replace(",", "."))
                    lon = float(row.get("LONGITUD", "0").replace(",", "."))
                    if lat != 0 and lon != 0:
                        estaciones.append({
                            "codigo":    row.get("CODIGO", "").zfill(5),
                            "nombre":    row.get("DESCRIPCION", "Estación Desconocida").strip(),
                            "direccion": row.get("DIRECION", "").strip(),
                            "cp":        row.get("CP", "").strip(),
                            "poblacion": row.get("POBLACION", "").strip(),
                            "provincia": row.get("PROVINCIA", "").strip(),
                            "lat": lat, "lon": lon
                        })
                except ValueError:
                    continue
    return JSONResponse(content=estaciones)

# ==========================================
# 8. ENDPOINTS API (ADIF)
# ==========================================
@app.get("/api/estacion/{code}/trenes")
async def get_adif_trains(code: str):
    await subscribe_station(code)
    for _ in range(10):
        if code in station_data:
            return station_data[code]
        await asyncio.sleep(0.5)
    raise HTTPException(status_code=504, detail=f"Sin datos para estación {code}.")


@app.websocket("/ws/{code}")
async def websocket_station(websocket: WebSocket, code: str):
    await websocket.accept()
    ws_clients.setdefault(code, []).append(websocket)
    await subscribe_station(code)

    # Enviar último dato disponible de inmediato si ya lo tenemos
    if code in station_data:
        await websocket.send_json(station_data[code])

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        if websocket in ws_clients.get(code, []):
            ws_clients[code].remove(websocket)