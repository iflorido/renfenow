import asyncio
import csv
import json
import logging
import os
import re
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ==========================================
# VARIABLES GLOBALES (RENFE GTFS-RT)
# ==========================================
URL_ALERTS   = "https://gtfsrt.renfe.com/alerts.json"
URL_VEHICLES = "https://gtfsrt.renfe.com/vehicle_positions.json"

NUCLEOS_RENFE = {
    "10": "Madrid",          "20": "Asturias",            "30": "Sevilla",
    "31": "Cádiz",           "32": "Málaga",              "40": "Valencia",
    "41": "Murcia/Alicante", "50": "Rodalies Catalunya",  "51": "Rodalies Catalunya",
    "60": "Bilbao",          "61": "San Sebastián",       "62": "Santander",
    "70": "Zaragoza",
}

# ==========================================
# CICLO DE VIDA
# ==========================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    yield

app = FastAPI(title="Dashboard Renfe & ADIF", lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ==========================================
# FUNCIONES AUXILIARES
# ==========================================
async def fetch_data(url: str, retries: int = 3):
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36"}
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
# ENDPOINTS FRONTEND
# ==========================================
@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

# ==========================================
# ENDPOINTS API — RENFE
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
            avisos.append({
                "titulo": titulo,
                "descripcion": descripcion,
                "lineas": ",".join(lineas_afectadas)
            })
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
                "id":          entity.get("id"),
                "linea_unica": f"{region_code}-{linea_corta}",
                "linea":       linea_corta,
                "nombre":      label,
                "lat":         lat,
                "lon":         lon,
                "provincia":   provincia,
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
                            "lat":       lat,
                            "lon":       lon,
                        })
                except ValueError:
                    continue
    return JSONResponse(content=estaciones)
