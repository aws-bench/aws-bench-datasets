FROM --platform=linux/amd64 public.ecr.aws/docker/library/node:22-slim

RUN apt-get update \
    && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY app.js .

CMD ["node", "app.js"]
