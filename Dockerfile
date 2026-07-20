FROM python:3.12-slim-bookworm

# NWChem from the Debian package (includes basis set libraries)
RUN apt-get update \
    && apt-get install -y --no-install-recommends nwchem \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN useradd -m appuser && chown -R appuser /srv
USER appuser

# Serial execution; NWChem threads don't help on small cloud instances
ENV OMP_NUM_THREADS=1

EXPOSE 8317
CMD ["sh", "-c", "uvicorn app.server:app --host 0.0.0.0 --port ${PORT:-8317}"]
