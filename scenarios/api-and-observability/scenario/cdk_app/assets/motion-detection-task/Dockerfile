FROM --platform=linux/amd64 public.ecr.aws/docker/library/python:3.11-slim

RUN apt-get update \
    && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY app.py .

RUN pip install --no-cache-dir boto3

CMD ["python", "app.py"]
