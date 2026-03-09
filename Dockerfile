# Usamos una imagen oficial de Python ligera
FROM python:3.11-slim

# Evita que Python genere archivos .pyc y fuerza a que la salida estándar se muestre en consola
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Creamos y establecemos el directorio de trabajo dentro del contenedor
WORKDIR /app

# Copiamos primero el archivo de dependencias (para aprovechar la caché de Docker)
COPY requirements.txt .

# Instalamos las dependencias
RUN pip install --no-cache-dir -r requirements.txt

# Copiamos el resto de los archivos del proyecto al contenedor
# Esto incluirá main.py, las carpetas templates/, static/ y data/
COPY . .

# Exponemos el puerto que usará FastAPI
EXPOSE 8095

# Comando para ejecutar la aplicación con Uvicorn
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8095"]