# Slim Debian-based image with Node 24 pre-installed to run CDK (TypeScript)
FROM --platform=linux/amd64 public.ecr.aws/docker/library/node:24-slim

WORKDIR /app

# Build-time deps: curl + unzip for AWS CLI installer; git for CDK asset
# hashing. --no-install-recommends keeps the layer small.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        unzip \
    && rm -rf /var/lib/apt/lists/*

# AWS CLI v2 (CDK shells out to it for some asset / bootstrap operations).
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" \
    && unzip -q awscliv2.zip \
    && ./aws/install \
    && rm -rf aws awscliv2.zip

# CDK CLI globally so deploy.sh can call `npx cdk`.
RUN npm install -g aws-cdk

# Copy the CDK app last so edits to TS source don't invalidate the layers above.
COPY cdk_app/ /app/cdk_app/
RUN cd /app/cdk_app && npm install
