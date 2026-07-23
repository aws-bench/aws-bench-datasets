FROM --platform=linux/amd64 public.ecr.aws/docker/library/node:24-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        unzip \
        python3 \
        python3-boto3 \
    && rm -rf /var/lib/apt/lists/*

ARG DOCKER_VERSION=29.6.1
RUN curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" \
    | tar xz --strip-components=1 -C /usr/local/bin docker/docker

RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" \
    && unzip -q awscliv2.zip \
    && ./aws/install \
    && rm -rf aws awscliv2.zip

RUN npm install -g aws-cdk

COPY cdk_app/ /app/cdk_app/
RUN cd /app/cdk_app && npm install
