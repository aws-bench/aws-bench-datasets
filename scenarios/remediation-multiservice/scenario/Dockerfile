FROM --platform=linux/amd64 public.ecr.aws/docker/library/node:24-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        python3 \
        python3-pip \
        unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" \
    && unzip -q awscliv2.zip \
    && ./aws/install \
    && rm -rf aws awscliv2.zip

RUN npm install -g aws-cdk

RUN pip3 install --break-system-packages boto3

COPY cdk_app/ /app/cdk_app/
RUN cd /app/cdk_app && npm install

COPY setup/ /app/setup/
