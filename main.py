from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import httpx
import asyncio
import re
import csv
import os

app = FastAPI(title="Renfe Realtime Dashboard")

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

URL_ALERTS = "https://gtfsrt.renfe.com/alerts.json"
URL_VEHICLES = "https://gtfsrt.renfe.com/vehicle_positions.json"

async def fetch_data(url: str, retries: int = 3):
    """Descarga JSON con reintentos y User-Agent para evitar bloqueos de Renfe."""
    # Renfe a veces bloquea peticiones si no parecen venir de un navegador
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    
    async with httpx.AsyncClient(verify=False, headers=headers) as client:
        for attempt in range(retries):
            try:
                response = await client.get(url, timeout=15.0)
                response.raise_for_status()
                data = response.json()
                
                # Comprobamos si Renfe nos ha devuelto la lista "entity" vacía
                if "entity" in data and len(data["entity"]) > 0:
                    return data
                else:
                    print(f"⚠️ {url} devolvió 0 datos en el intento {attempt + 1}. Reintentando...")
                    if attempt < retries - 1:
                        await asyncio.sleep(1.5) # Esperamos un poco antes de volver a llamar
                        continue
                    return data # Si ya es el último intento, devolvemos lo que hay
                    
            except Exception as e:
                print(f"❌ Error descargando {url} (Intento {attempt + 1}): {e}")
                if attempt < retries - 1:
                    await asyncio.sleep(2)
                else:
                    return {"entity": []}

@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/api/alerts", response_class=HTMLResponse)
async def get_alerts(request: Request):
    data = await fetch_data(URL_ALERTS)
    avisos = []
    
    for entity in data.get("entity", []):
        alert = entity.get("alert", {})
        translations = alert.get("descriptionText", {}).get("translation", [])
        
        # --- CORRECCIÓN: Extraer Región + Línea (Ej: "10-C2", "60-C3") ---
        informed_entity = alert.get("informedEntity", [])
        lineas_afectadas = set()
        for ie in informed_entity:
            route_id = ie.get("routeId", "")
            # Buscamos los 2 primeros dígitos (región) y la línea al final
            match = re.search(r'^(\d{2}).*?([A-Za-z]+[0-9]+[A-Za-z]*)$', route_id)
            if match:
                region = match.group(1)
                linea = match.group(2)
                lineas_afectadas.add(f"{region}-{linea}")
        
        if translations:
            full_text = translations[0].get("text", "Aviso sin descripción")
            partes = full_text.split(" ", 1)
            
            if len(partes) > 1 and (partes[0].startswith("#") or partes[0].endswith(":")):
                titulo = partes[0]
                descripcion = partes[1]
            else:
                titulo = "Información de Servicio"
                descripcion = full_text
            
            avisos.append({
                "titulo": titulo,
                "descripcion": descripcion,
                "lineas": ",".join(lineas_afectadas) # Ahora será "10-C2,10-C7"
            })
            
    return templates.TemplateResponse("partials/alerts.html", {"request": request, "avisos": avisos})

# Diccionario oficial de núcleos de Cercanías/Rodalies de Renfe
NUCLEOS_RENFE = {
    "10": "Madrid",
    "20": "Asturias",
    "30": "Sevilla",
    "31": "Cádiz",
    "32": "Málaga",
    "40": "Valencia",
    "41": "Murcia/Alicante",
    "50": "Rodalies Catalunya",
    "51": "Rodalies Catalunya",
    "60": "Bilbao",
    "61": "San Sebastián",
    "62": "Santander",
    "70": "Zaragoza",
}

@app.get("/api/vehiculos")
async def get_vehiculos():
    data = await fetch_data(URL_VEHICLES)
    trenes = []
    
    for entity in data.get("entity", []):
        vehicle_info = entity.get("vehicle", {})
        pos = vehicle_info.get("position", {})
        veh_data = vehicle_info.get("vehicle", {})
        trip = vehicle_info.get("trip", {})
        
        lat = pos.get("latitude")
        lon = pos.get("longitude")
        
        if lat and lon:
            label = veh_data.get("label", "Desconocido")
            linea_corta = label.split("-")[0] if "-" in label else "Genérica"
            
            # Extraemos la región y la traducimos a un nombre legible
            trip_id = trip.get("tripId", "")
            region_code = trip_id[:2] if len(trip_id) >= 2 else "00"
            provincia = NUCLEOS_RENFE.get(region_code, f"Región {region_code}")
            
            linea_unica = f"{region_code}-{linea_corta}"
            
            trenes.append({
                "id": entity.get("id"),
                "linea_unica": linea_unica,
                "linea": linea_corta,
                "nombre": label,
                "lat": lat,
                "lon": lon,
                "provincia": provincia  # <-- ¡Aquí añadimos la provincia!
            })
            
    return JSONResponse(content=trenes)

@app.get("/api/estaciones")
async def get_estaciones():
    """
    Lee el CSV de estaciones, corrige la codificación y devuelve un JSON.
    """
    estaciones = []
    file_path = os.path.join("data", "estaciones.csv")
    
    if os.path.exists(file_path):
        # Usamos latin-1 para arreglar las ñ y las tildes (el famoso )
        with open(file_path, mode="r", encoding="latin-1") as f:
            reader = csv.DictReader(f, delimiter=";")
            for row in reader:
                try:
                    # Sustituimos la coma por punto en caso de que los decimales vengan formato europeo
                    lat_str = row.get("LATITUD", "0").replace(",", ".")
                    lon_str = row.get("LONGITUD", "0").replace(",", ".")
                    
                    lat = float(lat_str)
                    lon = float(lon_str)
                    
                    if lat != 0 and lon != 0:
                        estaciones.append({
                            "codigo": row.get("CODIGO", ""),
                            "nombre": row.get("DESCRIPCION", "Estación Desconocida").strip(),
                            "direccion": row.get("DIRECION", "").strip(),
                            "cp": row.get("CP", "").strip(),
                            "poblacion": row.get("POBLACION", "").strip(),
                            "provincia": row.get("PROVINCIA", "").strip(),
                            "lat": lat,
                            "lon": lon
                        })
                except ValueError:
                    # Si alguna fila tiene coordenadas inválidas, la saltamos
                    continue
                    
    return JSONResponse(content=estaciones)