# Slim Debian-based image with Node 24 pre-installed to run CDK (TypeScript)
FROM --platform=linux/amd64 public.ecr.aws/docker/library/node:24-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        unzip \
        python3 \
        python3-pip \
    && rm -rf /var/lib/apt/lists/*

ARG DOCKER_VERSION=29.6.1
RUN curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" \
    | tar xz --strip-components=1 -C /usr/local/bin docker/docker

RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" \
    && unzip -q awscliv2.zip \
    && ./aws/install \
    && rm -rf aws awscliv2.zip

RUN npm install -g aws-cdk

RUN pip3 install --break-system-packages boto3

COPY cdk_app/ /app/cdk_app/
RUN cd /app/cdk_app && npm install

# Install per-asset npm dependencies so CDK bundles them into Lambda zips.
RUN find /app/cdk_app/assets -name package.json -not -path '*/node_modules/*' \
    -execdir npm install --omit=dev \;

COPY setup/ /app/setup/

# Setup scripts reference ../assets/ relative to their location
COPY cdk_app/assets/ /app/assets/
