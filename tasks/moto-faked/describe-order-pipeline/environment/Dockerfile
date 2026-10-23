FROM public.ecr.aws/docker/library/python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip less groff jq zip \
    && rm -rf /var/lib/apt/lists/*

# Install AWS CLI v2 (detect architecture)
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then \
        CLI_URL="https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip"; \
    else \
        CLI_URL="https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip"; \
    fi && \
    curl -sSL "$CLI_URL" -o /tmp/awscliv2.zip && \
    unzip -q /tmp/awscliv2.zip -d /tmp && \
    /tmp/aws/install && \
    rm -rf /tmp/aws /tmp/awscliv2.zip

RUN pip install --no-cache boto3 pyyaml

WORKDIR /app
