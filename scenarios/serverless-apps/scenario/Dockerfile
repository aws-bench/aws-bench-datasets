FROM --platform=linux/amd64 public.ecr.aws/docker/library/node:24-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        unzip \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# AWS CLI v2
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" \
    && unzip -q awscliv2.zip \
    && ./aws/install \
    && rm -rf aws awscliv2.zip

# CDK CLI
RUN npm install -g aws-cdk

# Copy the CDK app
COPY cdk_app/ /app/cdk_app/
RUN cd /app/cdk_app && npm install
